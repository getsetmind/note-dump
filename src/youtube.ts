import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { parse as parseHTML } from "node-html-parser";

/**
 * @description YouTube 動画 URL を本文 HTML から抽出
 * @param bodyHtml - note 記事の body HTML
 * @returns 重複除去済み URL 列
 */
export function extractYoutubeUrls(bodyHtml: string): string[] {
	const root = parseHTML(bodyHtml);
	const out = new Set<string>();
	for (const el of root.querySelectorAll("iframe, embed")) {
		const src = el.getAttribute("src") ?? "";
		if (src && isYoutube(src)) out.add(normalizeYoutube(src));
	}
	// note は本文内に直接 youtu.be リンクを置くことがあるので a も拾う
	for (const a of root.querySelectorAll("a")) {
		const href = a.getAttribute("href") ?? "";
		if (href && isYoutube(href)) out.add(normalizeYoutube(href));
	}
	return Array.from(out);
}

/**
 * @description YouTube ホスト判定
 */
function isYoutube(url: string): boolean {
	try {
		const u = new URL(url, "https://note.com");
		const h = u.hostname.replace(/^www\./, "");
		return (
			h === "youtube.com" ||
			h === "youtu.be" ||
			h === "youtube-nocookie.com" ||
			h.endsWith(".youtube.com")
		);
	} catch {
		return false;
	}
}

/**
 * @description /embed/<id> 形式を watch?v=<id> に正規化
 */
function normalizeYoutube(url: string): string {
	try {
		const u = new URL(url, "https://note.com");
		if (u.pathname.startsWith("/embed/")) {
			const id = u.pathname.slice("/embed/".length).split("/")[0];
			if (id) return `https://www.youtube.com/watch?v=${id}`;
		}
		return u.toString();
	} catch {
		return url;
	}
}

/**
 * @description yt-dlp が PATH に居るかチェック
 */
async function ytDlpAvailable(): Promise<boolean> {
	return await new Promise((res) => {
		const p = spawn("yt-dlp", ["--version"], { stdio: "ignore", shell: true });
		p.on("error", () => res(false));
		p.on("exit", (code) => res(code === 0));
	});
}

/**
 * @description yt-dlp を起動して 1 本ダウンロード
 */
function runYtDlp(url: string, outDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const args = [
			"--no-progress",
			"--no-warnings",
			"-o",
			"%(id)s.%(ext)s",
			"-P",
			outDir,
			url,
		];
		const p = spawn("yt-dlp", args, { stdio: "inherit", shell: true });
		p.on("error", reject);
		p.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`yt-dlp exit ${code} (${url})`));
		});
	});
}

/**
 * @description 抽出した YouTube URL を全て yt-dlp で DL。未インストール時は warn してスキップ
 * @returns 成功した URL 数
 */
export async function downloadYoutubeAll(
	urls: string[],
	outDir: string,
): Promise<number> {
	if (urls.length === 0) return 0;
	if (!(await ytDlpAvailable())) {
		console.warn(
			"  [yt-dlp] 見つからないためスキップ。`pip install yt-dlp` などで導入してください",
		);
		return 0;
	}
	await mkdir(outDir, { recursive: true });
	let ok = 0;
	for (const url of urls) {
		try {
			await runYtDlp(url, outDir);
			ok++;
		} catch (e) {
			console.warn(`  [yt-dlp] ${url} 失敗: ${(e as Error).message}`);
		}
	}
	return ok;
}
