/**
 * CDP のイベントまたは RPC 応答
 */
interface CdpMessage {
	id?: number;
	method?: string;
	sessionId?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message: string };
}

/**
 * CDP に複数 RPC を投げ、Page イベントを待てる軽量クライアント
 * 1 WebSocket をプールして送信 ID と pending を自前管理する
 */
class CdpSession {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{
			resolve: (v: Record<string, unknown>) => void;
			reject: (e: Error) => void;
		}
	>();
	private readonly waiters: Array<{
		method: string;
		sessionId: string | undefined;
		resolve: (params: Record<string, unknown>) => void;
	}> = [];

	/**
	 * ブラウザ単位の WebSocket に接続する
	 */
	async connect(wsUrl: string): Promise<void> {
		await new Promise<void>((res, rej) => {
			const ws = new WebSocket(wsUrl);
			const t = setTimeout(() => rej(new Error("CDP WS open timeout")), 8000);
			ws.onopen = () => {
				clearTimeout(t);
				this.ws = ws;
				ws.onmessage = (ev) => {
					this.dispatch(JSON.parse(ev.data as string) as CdpMessage);
				};
				res();
			};
			ws.onerror = () => {
				clearTimeout(t);
				rej(new Error("CDP WS error"));
			};
		});
	}

	/**
	 * 受信メッセージをディスパッチする
	 */
	private dispatch(m: CdpMessage): void {
		if (m.id !== undefined) {
			this.settlePending(m.id, m.result, m.error);
			return;
		}
		if (m.method) {
			this.resolveWaiters(m.method, m.sessionId, m.params ?? {});
		}
	}

	/**
	 * RPC 応答で pending を解決する
	 */
	private settlePending(
		id: number,
		result: Record<string, unknown> | undefined,
		error: { message: string } | undefined,
	): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		if (error) {
			p.reject(new Error(error.message));
		} else {
			p.resolve(result ?? {});
		}
	}

	/**
	 * 一致するイベント待ちを 1 件解決する
	 */
	private resolveWaiters(
		method: string,
		sessionId: string | undefined,
		params: Record<string, unknown>,
	): void {
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const w = this.waiters[i];
			if (!w) continue;
			if (w.method === method && w.sessionId === sessionId) {
				this.waiters.splice(i, 1);
				w.resolve(params);
			}
		}
	}

	/**
	 * 1 件 RPC を送って結果を待つ
	 */
	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		const ws = this.ws;
		if (!ws) throw new Error("not connected");
		const id = this.nextId++;
		const msg: Record<string, unknown> = { id, method, params };
		if (sessionId) msg.sessionId = sessionId;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			ws.send(JSON.stringify(msg));
		});
	}

	/**
	 * 指定イベントを 1 回だけ待つ
	 */
	waitFor(
		method: string,
		sessionId?: string,
		timeoutMs = 30000,
	): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				const idx = this.waiters.findIndex(
					(w) => w.method === method && w.sessionId === sessionId,
				);
				if (idx >= 0) this.waiters.splice(idx, 1);
				reject(new Error(`CDP event timeout: ${method}`));
			}, timeoutMs);
			this.waiters.push({
				method,
				sessionId,
				resolve: (p) => {
					clearTimeout(t);
					resolve(p);
				},
			});
		});
	}

	/**
	 * WebSocket を閉じてセッションを破棄する
	 */
	close(): void {
		this.ws?.close();
		this.ws = null;
	}
}

/**
 * /json/version からブラウザレベルの WebSocket URL を取得する
 */
async function getBrowserWsUrl(cdpUrl: string): Promise<string> {
	const res = await fetch(`${cdpUrl}/json/version`);
	if (!res.ok) {
		throw new Error(
			`CDP に接続できない (${cdpUrl}). ブラウザを --remote-debugging-port 付きで起動済みか確認してください。`,
		);
	}
	const j = (await res.json()) as { webSocketDebuggerUrl?: string };
	if (!j.webSocketDebuggerUrl) {
		throw new Error("/json/version に webSocketDebuggerUrl が無い");
	}
	return j.webSocketDebuggerUrl;
}

/**
 * CDP で URL を開き、ログイン UI 除去と lazy-load 発火を経た outerHTML を返す
 */
export async function captureRenderedHtml(
	cdpUrl: string,
	targetUrl: string,
): Promise<string> {
	const wsUrl = await getBrowserWsUrl(cdpUrl);
	const sess = new CdpSession();
	await sess.connect(wsUrl);

	let targetId: string | undefined;
	let sessionId: string | undefined;
	try {
		const created = (await sess.send("Target.createTarget", {
			url: "about:blank",
		})) as { targetId: string };
		targetId = created.targetId;

		const attached = (await sess.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})) as { sessionId: string };
		sessionId = attached.sessionId;

		await sess.send("Page.enable", {}, sessionId);

		const loadWait = sess.waitFor("Page.loadEventFired", sessionId, 45000);
		await sess.send("Page.navigate", { url: targetUrl }, sessionId);
		await loadWait;

		// 1. ヘッダ (右上アバター等のログインユーザー UI) を除去
		// 2. 末尾までスクロールして lazy-load 画像の data-src を src に反映させる
		// 3. <!DOCTYPE html> 込みで outerHTML を返す
		const r = (await sess.send(
			"Runtime.evaluate",
			{
				awaitPromise: true,
				returnByValue: true,
				expression: `(async () => {
					document.querySelectorAll('header').forEach((e) => e.remove());
					window.scrollTo(0, document.documentElement.scrollHeight);
					await new Promise((r) => setTimeout(r, 800));
					window.scrollTo(0, 0);
					// file:// で開かれた時に Nuxt/Vue が再ハイドレートして 'ページなし' になるのを防ぐ
					// 同時に currentUser を含む __NUXT__ 状態も丸ごと消える
					document.querySelectorAll('script, noscript').forEach((e) => e.remove());
					return '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
				})()`,
			},
			sessionId,
		)) as { result?: { value?: string } };
		const html = r.result?.value;
		if (typeof html !== "string") throw new Error("HTML 取得失敗");
		return html;
	} finally {
		try {
			if (targetId) await sess.send("Target.closeTarget", { targetId });
		} catch (e) {
			console.warn(`  [snapshot] target close 失敗: ${(e as Error).message}`);
		}
		sess.close();
	}
}
