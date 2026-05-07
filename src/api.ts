import { parse as parseHTML } from "node-html-parser";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface NoteRef {
	key: string;
	url: string;
	title: string | undefined;
	creatorUrlname: string | undefined;
}

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

export class NoteClient {
	private readonly cookie: string;
	private readonly delayMs: number;
	private lastAt = 0;

	constructor(cookie: string, delayMs: number) {
		this.cookie = cookie;
		this.delayMs = delayMs;
	}

	private async throttle(): Promise<void> {
		const now = Date.now();
		const wait = this.lastAt + this.delayMs - now;
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastAt = Date.now();
	}

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
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
		}
		return await res.text();
	}

	async getJSON<T>(url: string): Promise<T> {
		const text = await this.getText(url, "application/json");
		return JSON.parse(text) as T;
	}

	async fetchBinary(url: string): Promise<{ buf: ArrayBuffer; type: string }> {
		await this.throttle();
		const res = await fetch(url, {
			headers: { "User-Agent": UA, Referer: "https://note.com/" },
			redirect: "follow",
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
		}
		const buf = await res.arrayBuffer();
		const type = res.headers.get("content-type") ?? "application/octet-stream";
		return { buf, type };
	}

	async fetchNote(key: string): Promise<NoteDetail> {
		const url = `https://note.com/api/v3/notes/${key}`;
		const j = (await this.getJSON<{ data: Record<string, unknown> }>(url)).data;
		const user = j.user as { urlname?: string; nickname?: string } | undefined;
		return {
			key: String(j.key ?? key),
			name: String(j.name ?? ""),
			body: String(j.body ?? ""),
			createdAt: j.created_at ? String(j.created_at) : undefined,
			publishAt: j.publish_at ? String(j.publish_at) : undefined,
			user: user?.urlname
				? { urlname: user.urlname, nickname: user.nickname ?? "" }
				: undefined,
			priceText: j.price ? String(j.price) : undefined,
			raw: j,
		};
	}

	async fetchPurchasedKeys(): Promise<NoteRef[]> {
		const collected: NoteRef[] = [];
		const seen = new Set<string>();

		for (const candidate of [
			"https://note.com/api/v1/purchased_notes",
			"https://note.com/api/v2/purchased_notes",
			"https://note.com/api/v3/purchased_notes",
			"https://note.com/api/v1/users/me/purchased_contents",
			"https://note.com/api/v2/users/me/purchased_contents",
		]) {
			try {
				let page = 1;
				while (page <= 50) {
					const url = `${candidate}?page=${page}`;
					const j = await this.getJSON<{
						data?: {
							notes?: Array<Record<string, unknown>>;
							contents?: Array<Record<string, unknown>>;
							last_page?: boolean;
							is_last_page?: boolean;
						};
					}>(url);
					const items = j.data?.notes ?? j.data?.contents ?? [];
					if (items.length === 0) break;
					let added = 0;
					for (const it of items) {
						const ref = toRef(it);
						if (ref && !seen.has(ref.key)) {
							seen.add(ref.key);
							collected.push(ref);
							added++;
						}
					}
					console.log(
						`[api] ${candidate} page=${page} +${added} (total ${collected.length})`,
					);
					const last = j.data?.last_page ?? j.data?.is_last_page ?? false;
					if (last) break;
					page++;
				}
				if (collected.length > 0) return collected;
			} catch (e) {
				console.warn(`[api] ${candidate} 失敗: ${(e as Error).message}`);
			}
		}

		console.warn(
			"[api] 公式APIで購入済み一覧が取れなかったため、ライブラリページのHTMLを解析します。",
		);
		return await this.fetchPurchasedFromLibraryHTML();
	}

	private async fetchPurchasedFromLibraryHTML(): Promise<NoteRef[]> {
		const candidates = [
			"https://note.com/library/purchased",
			"https://note.com/library",
			"https://note.com/mypage/purchased",
			"https://note.com/settings/purchased",
		];
		for (const url of candidates) {
			try {
				const html = await this.getText(url);
				const root = parseHTML(html);
				const anchors = root.querySelectorAll("a");
				const found = new Map<string, NoteRef>();
				for (const a of anchors) {
					const href = a.getAttribute("href") ?? "";
					const m = href.match(/\/(?:[^/]+)?\/?n\/([a-z0-9]{8,})/i);
					if (!m) continue;
					const key = m[1];
					if (!key) continue;
					const fullUrl = href.startsWith("http")
						? href
						: `https://note.com${href}`;
					const title = a.text.trim();
					if (!found.has(key)) {
						found.set(key, {
							key,
							url: fullUrl,
							title: title || undefined,
							creatorUrlname: undefined,
						});
					}
				}
				if (found.size > 0) {
					console.log(`[api] library HTML (${url}) から ${found.size} 件抽出`);
					return [...found.values()];
				}
			} catch (e) {
				console.warn(`[api] ${url} 失敗: ${(e as Error).message}`);
			}
		}
		return [];
	}
}

function toRef(it: Record<string, unknown>): NoteRef | undefined {
	const note = (it.note as Record<string, unknown> | undefined) ?? it;
	const key = note.key;
	if (typeof key !== "string") return undefined;
	const user = note.user as { urlname?: string } | undefined;
	const urlname = user?.urlname;
	const url =
		typeof note.note_url === "string"
			? (note.note_url as string)
			: urlname
				? `https://note.com/${urlname}/n/${key}`
				: `https://note.com/n/${key}`;
	return {
		key,
		url,
		title: typeof note.name === "string" ? (note.name as string) : undefined,
		creatorUrlname: urlname,
	};
}

export function parseUrlOrKey(s: string): string | undefined {
	const trimmed = s.trim();
	if (trimmed === "") return undefined;
	const m = trimmed.match(/n\/([a-z0-9]{8,})/i);
	if (m) return m[1];
	if (/^[a-z0-9]{8,}$/i.test(trimmed)) return trimmed;
	return undefined;
}
