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
 * 送信済み RPC の応答待ち
 */
interface PendingRpc {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

/**
 * 特定イベントの受信待ち
 */
interface Waiter {
	method: string;
	sessionId: string | undefined;
	resolve: (params: Record<string, unknown>) => void;
}

/**
 * /json/version 取得のタイムアウト (ms)
 */
const CDP_HTTP_TIMEOUT_MS = 8000;

/**
 * WebSocket 接続確立のタイムアウト (ms)
 */
const CDP_WS_OPEN_TIMEOUT_MS = 8000;

/**
 * イベント待ちの既定タイムアウト (ms)
 */
const CDP_EVENT_TIMEOUT_MS = 30000;

/**
 * ページ読み込み完了イベントの待ち時間 (ms)
 */
const CDP_PAGE_LOAD_TIMEOUT_MS = 45000;

/**
 * lazy-load を発火させるスクロール後に待つ時間 (ms)
 */
const LAZY_LOAD_SETTLE_MS = 800;

/**
 * ページ内で実行するスナップショット取得スクリプト
 * header 除去、末尾スクロールによる lazy-load 発火、Nuxt 再ハイドレート防止をまとめて行う
 */
const SNAPSHOT_EXPRESSION = `(async () => {
  document.querySelectorAll('header').forEach((e) => e.remove());
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise((r) => setTimeout(r, ${LAZY_LOAD_SETTLE_MS}));
  window.scrollTo(0, 0);
  // file:// で開かれた時に Nuxt/Vue が再ハイドレートして 'ページなし' になるのを防ぐ
  // 同時に currentUser を含む __NUXT__ 状態も丸ごと消える
  document.querySelectorAll('script, noscript').forEach((e) => e.remove());
  return '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
})()`;

/**
 * 受信値を CdpMessage として扱えるか判定する
 * 既知フィールドはすべて任意なので、オブジェクトであることだけを確認する
 */
function isCdpMessage(value: unknown): value is CdpMessage {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CDP に複数 RPC を投げ、Page イベントを待てる軽量クライアント
 * 1 WebSocket をプールして送信 ID と pending を自前管理する
 */
class CdpSession {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRpc>();
	private readonly waiters: Waiter[] = [];

	/**
	 * ブラウザ単位の WebSocket に接続する
	 */
	async connect(wsUrl: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			const timer = setTimeout(
				() => reject(new Error("CDP WS open timeout")),
				CDP_WS_OPEN_TIMEOUT_MS,
			);
			ws.onopen = () => {
				clearTimeout(timer);
				this.ws = ws;
				ws.onmessage = (ev) => {
					const parsed: unknown = JSON.parse(ev.data as string);
					if (isCdpMessage(parsed)) this.dispatch(parsed);
				};
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("CDP WS error"));
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
		const rpc = this.pending.get(id);
		if (!rpc) return;
		this.pending.delete(id);
		if (error) {
			rpc.reject(new Error(error.message));
		} else {
			rpc.resolve(result ?? {});
		}
	}

	/**
	 * 一致するイベント待ちをすべて解決する
	 */
	private resolveWaiters(
		method: string,
		sessionId: string | undefined,
		params: Record<string, unknown>,
	): void {
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const waiter = this.waiters[i];
			if (!waiter) continue;
			if (waiter.method !== method || waiter.sessionId !== sessionId) continue;
			this.waiters.splice(i, 1);
			waiter.resolve(params);
		}
	}

	/**
	 * 1 件 RPC を送って結果を待つ
	 * 応答の形は CDP 側の仕様に依存するため、呼び出し側が型引数で指定する
	 */
	send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<T> {
		const ws = this.ws;
		if (!ws) throw new Error("not connected");
		const id = this.nextId++;
		const msg: Record<string, unknown> = { id, method, params };
		if (sessionId) msg.sessionId = sessionId;
		const response = new Promise<Record<string, unknown>>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			ws.send(JSON.stringify(msg));
		});
		return response as Promise<T>;
	}

	/**
	 * 指定イベントを 1 回だけ待つ
	 * タイムアウト時は自分自身の waiter だけを取り除く
	 */
	waitFor(
		method: string,
		sessionId?: string,
		timeoutMs = CDP_EVENT_TIMEOUT_MS,
	): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter: Waiter = {
				method,
				sessionId,
				resolve: (params) => {
					clearTimeout(timer);
					resolve(params);
				},
			};
			timer = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error(`CDP event timeout: ${method}`));
			}, timeoutMs);
			this.waiters.push(waiter);
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
	const res = await fetch(`${cdpUrl}/json/version`, {
		signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(
			`CDP に接続できない (${cdpUrl}). ブラウザを --remote-debugging-port 付きで起動済みか確認してください。`,
		);
	}
	const body: unknown = await res.json();
	if (
		typeof body !== "object" ||
		body === null ||
		!("webSocketDebuggerUrl" in body)
	) {
		throw new Error("/json/version に webSocketDebuggerUrl が無い");
	}
	const wsUrl = body.webSocketDebuggerUrl;
	if (typeof wsUrl !== "string") {
		throw new Error("/json/version の webSocketDebuggerUrl が文字列でない");
	}
	return wsUrl;
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
	try {
		const created = await sess.send<{ targetId: string }>(
			"Target.createTarget",
			{
				url: "about:blank",
			},
		);
		targetId = created.targetId;

		const attached = await sess.send<{ sessionId: string }>(
			"Target.attachToTarget",
			{ targetId, flatten: true },
		);
		const sessionId = attached.sessionId;

		await sess.send("Page.enable", {}, sessionId);

		const loadWait = sess.waitFor(
			"Page.loadEventFired",
			sessionId,
			CDP_PAGE_LOAD_TIMEOUT_MS,
		);
		await sess.send("Page.navigate", { url: targetUrl }, sessionId);
		await loadWait;

		const evaluated = await sess.send<{ result?: { value?: unknown } }>(
			"Runtime.evaluate",
			{
				awaitPromise: true,
				returnByValue: true,
				expression: SNAPSHOT_EXPRESSION,
			},
			sessionId,
		);
		const html = evaluated.result?.value;
		if (typeof html !== "string") throw new Error("HTML 取得失敗");
		return html;
	} finally {
		try {
			if (targetId) await sess.send("Target.closeTarget", { targetId });
			// biome-ignore lint/plugin: target close 失敗より WS を閉じる後始末を優先する
		} catch (e) {
			console.warn(`  [snapshot] target close 失敗: ${(e as Error).message}`);
		}
		sess.close();
	}
}
