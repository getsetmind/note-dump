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
	// note.com の埋め込みは <figure data-src="..." embedded-service="youtube"> 形式
	for (const el of root.querySelectorAll('[embedded-service="youtube"]')) {
		const src = el.getAttribute("data-src") ?? el.getAttribute("src") ?? "";
		if (src && isYoutube(src)) out.add(normalizeYoutube(src));
	}
	// 一般的な iframe/embed 直書き (他サイトからのコピペ等)
	for (const el of root.querySelectorAll("iframe, embed")) {
		const src = el.getAttribute("src") ?? "";
		if (src && isYoutube(src)) out.add(normalizeYoutube(src));
	}
	// 本文内のテキストリンク
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
 * @description yt-dlp が PATH に居るかチェック (Bun.spawn で Windows .cmd shim も直接解決)
 */
async function ytDlpAvailable(): Promise<boolean> {
	try {
		const p = Bun.spawn(["yt-dlp", "--version"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const code = await p.exited;
		return code === 0;
	} catch {
		return false;
	}
}

/**
 * @description yt-dlp を起動して 1 本 DL。shell を経由しないためパスにスペースが入っても安全
 */
async function runYtDlp(url: string, outDir: string): Promise<void> {
	const p = Bun.spawn(
		[
			"yt-dlp",
			"--no-progress",
			"--no-warnings",
			"-o",
			"%(id)s.%(ext)s",
			"-P",
			outDir,
			url,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	const code = await p.exited;
	if (code !== 0) throw new Error(`yt-dlp exit ${code} (${url})`);
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
