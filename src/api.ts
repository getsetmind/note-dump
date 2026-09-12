import {
	NoteDetailResponseSchema,
	PurchasedItemSchema,
	PurchasedListResponseSchema,
} from "./schemas";

/**
 * note.com に送る User-Agent
 */
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

/**
 * 暴走を防ぐための購入済み API のページング上限
 */
const MAX_PURCHASE_PAGES = 200;

/**
 * テキスト API のタイムアウト (ms)
 */
const REQUEST_TIMEOUT_MS = 30000;

/**
 * 画像などバイナリ取得のタイムアウト (ms)
 */
const BINARY_TIMEOUT_MS = 60000;

/**
 * 一覧取得時に使う最小限の記事情報
 */
export interface NoteRef {
	key: string;
	url: string;
	title: string | undefined;
	creatorUrlname: string | undefined;
}

/**
 * 詳細 API から正規化した記事データ
 */
export interface NoteDetail {
	key: string;
	name: string;
	body: string;
	createdAt: string | undefined;
	publishAt: string | undefined;
	user: { urlname: string; nickname: string } | undefined;
	priceText: string | undefined;
	raw: unknown;
}

/**
 * Cookie 付き fetch、直列スロットリング、zod 検証を担う薄いクライアント
 */
export class NoteClient {
	private readonly cookie: string;
	private readonly delayMs: number;
	private lastAt = 0;

	/**
	 * Cookie とリクエスト間隔を指定して初期化する
	 */
	constructor(cookie: string, delayMs: number) {
		this.cookie = cookie;
		this.delayMs = delayMs;
	}

	/**
	 * 直前リクエストから delayMs 経過するまで待つ
	 */
	private async throttle(): Promise<void> {
		const now = Date.now();
		const wait = this.lastAt + this.delayMs - now;
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastAt = Date.now();
	}

	/**
	 * Cookie/UA/Referer 付きで GET してテキストを返す
	 */
	async getText(
		url: string,
		accept = "text/html,application/json",
	): Promise<string> {
		await this.throttle();
		const res = await fetch(url, {
			headers: {
				Cookie: this.cookie,
				"User-Agent": UA,
				Accept: accept,
				"Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
				Referer: "https://note.com/",
			},
			redirect: "follow",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
		}
		return await res.text();
	}

	/**
	 * JSON を取得する
	 * 検証前の生値を返すため、呼び出し側で zod により検証する
	 */
	async getJSON(url: string): Promise<unknown> {
		const text = await this.getText(url, "application/json");
		return JSON.parse(text);
	}

	/**
	 * 画像など Cookie 不要なバイナリを取得する
	 */
	async fetchBinary(url: string): Promise<{ buf: ArrayBuffer; type: string }> {
		await this.throttle();
		const res = await fetch(url, {
			headers: { "User-Agent": UA, Referer: "https://note.com/" },
			redirect: "follow",
			signal: AbortSignal.timeout(BINARY_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
		}
		const buf = await res.arrayBuffer();
		const type = res.headers.get("content-type") ?? "application/octet-stream";
		return { buf, type };
	}

	/**
	 * 記事詳細を取得して NoteDetail に正規化する
	 * スキーマ不一致時は zod のエラーメッセージごと throw する
	 */
	async fetchNote(key: string): Promise<NoteDetail> {
		const url = `https://note.com/api/v3/notes/${key}`;
		const json = await this.getJSON(url);
		const parsed = NoteDetailResponseSchema.safeParse(json);
		if (!parsed.success) {
			throw new Error(
				`[api] note ${key} のレスポンスが想定と異なる: ${parsed.error.message}`,
			);
		}
		const j = parsed.data.data;
		const user = j.user;
		return {
			key: j.key ?? key,
			name: j.name ?? "",
			body: j.body ?? "",
			createdAt: j.created_at,
			publishAt: j.publish_at,
			user: user?.urlname
				? { urlname: user.urlname, nickname: user.nickname ?? "" }
				: undefined,
			priceText: j.price !== undefined ? String(j.price) : undefined,
			raw: j,
		};
	}

	/**
	 * 購入済み一覧を全ページ取得する
	 * 1 件ごとに zod 検証し、不正アイテムは warn でスキップして継続する
	 */
	async fetchPurchasedKeys(): Promise<NoteRef[]> {
		const collected: NoteRef[] = [];
		const seen = new Set<string>();

		const endpoint =
			"https://note.com/api/v3/payments/purchase_notes?note_intro_only=true";
		let page = 1;
		while (page <= MAX_PURCHASE_PAGES) {
			const url = `${endpoint}&page=${page}`;
			const json = await this.getJSON(url);
			const parsed = PurchasedListResponseSchema.safeParse(json);
			if (!parsed.success) {
				console.warn(
					`[api] page=${page} のレスポンス形が不正のため打ち切り: ${parsed.error.message}`,
				);
				break;
			}
			const items = parsed.data.data ?? [];
			if (items.length === 0) break;
			const { added, skipped } = collectRefs(items, collected, seen);
			const skipNote = skipped > 0 ? ` (skip ${skipped})` : "";
			console.log(
				`[api] page=${page} +${added}${skipNote} (total ${collected.length})`,
			);
			page++;
		}
		return collected;
	}
}

/**
 * 1 ページぶんのアイテムを zod 検証して collected へ重複なく追加する
 * 検証に失敗したアイテムは skipped に数えて読み飛ばす
 */
function collectRefs(
	items: unknown[],
	collected: NoteRef[],
	seen: Set<string>,
): { added: number; skipped: number } {
	let added = 0;
	let skipped = 0;
	for (const item of items) {
		const ref = parseRef(item);
		if (!ref) {
			skipped++;
			continue;
		}
		if (seen.has(ref.key)) continue;
		seen.add(ref.key);
		collected.push(ref);
		added++;
	}
	return { added, skipped };
}

/**
 * 購入済み 1 アイテムを zod でパースして NoteRef に正規化する
 * 検証失敗時は undefined を返してスキップ判断は呼び出し側に委ねる
 */
function parseRef(item: unknown): NoteRef | undefined {
	const parsed = PurchasedItemSchema.safeParse(item);
	if (!parsed.success) return undefined;
	const note = parsed.data;
	const urlname = note.user?.urlname;
	const url =
		note.note_url ??
		(urlname
			? `https://note.com/${urlname}/n/${note.key}`
			: `https://note.com/n/${note.key}`);
	return {
		key: note.key,
		url,
		title: note.name,
		creatorUrlname: urlname,
	};
}

/**
 * URL または note key 文字列から key を抽出する
 * 解釈不能な場合は undefined
 */
export function parseUrlOrKey(s: string): string | undefined {
	const trimmed = s.trim();
	if (trimmed === "") return undefined;
	const m = trimmed.match(/n\/([a-z0-9]{8,})/i);
	if (m) return m[1];
	if (/^[a-z0-9]{8,}$/i.test(trimmed)) return trimmed;
	return undefined;
}
