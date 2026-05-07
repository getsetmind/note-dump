/**
 * @description note.com に送る User-Agent
 */
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * @description 購入済み API のページング上限。暴走防止のため
 */
const MAX_PURCHASE_PAGES = 200;

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

		const endpoint =
			"https://note.com/api/v3/payments/purchase_notes?note_intro_only=true";
		let page = 1;
		while (page <= MAX_PURCHASE_PAGES) {
			const url = `${endpoint}&page=${page}`;
			const j = await this.getJSON<{ data?: Array<Record<string, unknown>> }>(
				url,
			);
			const items = Array.isArray(j.data) ? j.data : [];
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
			console.log(`[api] page=${page} +${added} (total ${collected.length})`);
			page++;
		}
		return collected;
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
