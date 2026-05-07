// CDP (Chrome DevTools Protocol) 経由で note.com の Cookie を全取得して .env を生成する。
// httpOnly Cookie も含めて取れる。
//
// 前提:
//  - Comet (または Chrome) を `--remote-debugging-port=9222` 付きで起動済みであること
//  - note.com にログイン済みのタブが1つ以上開いていること (なくても browser target で取れるが、
//    任意のページ target が要るため何かしら開いていた方が確実)
//
// 使い方:
//   bun run scripts/get-cookie-cdp.ts          # .env を上書き生成
//   bun run scripts/get-cookie-cdp.ts --print  # 標準出力に出すだけ
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CDP_URL = "http://localhost:9222";
const PRINT_ONLY = process.argv.includes("--print");

interface CdpPage {
	id: string;
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}

interface CdpCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	httpOnly: boolean;
	secure: boolean;
}

async function listPages(): Promise<CdpPage[]> {
	const res = await fetch(`${CDP_URL}/json/list`);
	if (!res.ok) {
		throw new Error(
			`CDP に接続できない (${CDP_URL}). Comet を --remote-debugging-port=9222 付きで起動しているか確認してください。`,
		);
	}
	return (await res.json()) as CdpPage[];
}

function rpc<T>(wsUrl: string, method: string, params: object): Promise<T> {
	return new Promise((resolveP, rejectP) => {
		const ws = new WebSocket(wsUrl);
		const timeout = setTimeout(() => {
			ws.close();
			rejectP(new Error(`CDP RPC timeout: ${method}`));
		}, 8000);
		ws.onopen = () => {
			ws.send(JSON.stringify({ id: 1, method, params }));
		};
		ws.onmessage = (ev) => {
			const data = JSON.parse(ev.data as string);
			if (data.id !== 1) return;
			clearTimeout(timeout);
			ws.close();
			if (data.error) {
				rejectP(new Error(`${method}: ${data.error.message}`));
				return;
			}
			resolveP(data.result as T);
		};
		ws.onerror = (e) => {
			clearTimeout(timeout);
			rejectP(new Error(`WS error: ${String(e)}`));
		};
	});
}

async function getCookies(): Promise<CdpCookie[]> {
	const pages = await listPages();
	const target = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
	if (!target) {
		throw new Error(
			"CDP page target が見つからない。Comet で何かタブを1つ開いてください。",
		);
	}
	const r = await rpc<{ cookies: CdpCookie[] }>(
		target.webSocketDebuggerUrl,
		"Network.getCookies",
		{ urls: ["https://note.com", "https://note.com/"] },
	);
	return r.cookies;
}

function toCookieHeader(cookies: CdpCookie[]): string {
	return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function upsertEnv(envPath: string, cookieHeader: string): void {
	const line = `NOTE_COOKIE="${cookieHeader}"`;
	if (!existsSync(envPath)) {
		writeFileSync(envPath, `${line}\n`, "utf8");
		return;
	}
	const text = readFileSync(envPath, "utf8");
	const lines = text.split(/\r?\n/);
	let replaced = false;
	const next = lines.map((l) => {
		if (l.startsWith("NOTE_COOKIE=") || l.startsWith("NOTE_COOKIE =")) {
			replaced = true;
			return line;
		}
		return l;
	});
	if (!replaced) next.push(line);
	writeFileSync(envPath, next.join("\n"), "utf8");
}

async function main(): Promise<void> {
	const cookies = await getCookies();
	if (cookies.length === 0) {
		console.error(
			"note.com の Cookie が見つかりません。一度 https://note.com を開いてログインしてください。",
		);
		process.exit(2);
	}

	const required = ["_note_session_v5"];
	const missing = required.filter((n) => !cookies.some((c) => c.name === n));
	if (missing.length > 0) {
		console.warn(
			`[警告] 必須 Cookie が見つかりません: ${missing.join(", ")} (未ログインの可能性)`,
		);
	}

	const header = toCookieHeader(cookies);
	console.log(`[ok] ${cookies.length} 個の Cookie を取得`);
	for (const c of cookies) {
		console.log(`  - ${c.name}${c.httpOnly ? " (httpOnly)" : ""}`);
	}

	if (PRINT_ONLY) {
		console.log("\n--- Cookie ヘッダ ---");
		console.log(header);
		return;
	}

	const envPath = resolve(process.cwd(), ".env");
	upsertEnv(envPath, header);
	console.log(`[ok] ${envPath} に NOTE_COOKIE を書き込みました`);
}

main().catch((e: Error) => {
	console.error(e.message);
	process.exit(1);
});
