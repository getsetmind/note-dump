import { mkdir, readdir } from "node:fs/promises";
import { parse as parseHTML } from "node-html-parser";

/**
 * 本文 HTML から YouTube 動画 URL を重複なく抽出する
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
 * YouTube のホストかどうかを判定する
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
 * URL から YouTube 動画 ID を抽出する
 */
export function extractYoutubeId(url: string): string | undefined {
	try {
		const u = new URL(url, "https://note.com");
		const h = u.hostname.replace(/^www\./, "");
		if (h === "youtu.be") return u.pathname.slice(1).split("/")[0] || undefined;
		if (u.pathname.startsWith("/embed/")) {
			return u.pathname.slice("/embed/".length).split("/")[0] || undefined;
		}
		if (u.pathname.startsWith("/shorts/")) {
			return u.pathname.slice("/shorts/".length).split("/")[0] || undefined;
		}
		if (u.pathname === "/watch") return u.searchParams.get("v") ?? undefined;
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * /embed/<id> 形式を watch?v=<id> に正規化する
 */
function normalizeYoutube(url: string): string {
	const id = extractYoutubeId(url);
	if (id) return `https://www.youtube.com/watch?v=${id}`;
	return url;
}

/**
 * ytDlpAvailable() の結果をプロセス内で再利用するキャッシュ
 */
let ytDlpAvailableCache: boolean | undefined;

/**
 * yt-dlp が PATH にあるか確認する (Bun.spawn で Windows の .cmd shim も直接解決)
 * 記事ごとに呼ばれるためプロセス内で一度だけ判定して結果を再利用する
 */
async function ytDlpAvailable(): Promise<boolean> {
	if (ytDlpAvailableCache !== undefined) return ytDlpAvailableCache;
	try {
		const p = Bun.spawn(["yt-dlp", "--version"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const code = await p.exited;
		ytDlpAvailableCache = code === 0;
	} catch {
		ytDlpAvailableCache = false;
	}
	return ytDlpAvailableCache;
}

/**
 * yt-dlp を起動して 1 本ダウンロードする
 * shell を経由しないためパスにスペースが入っても安全
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
 * 抽出した YouTube URL をすべて yt-dlp でダウンロードする
 * 未インストール時は warn してスキップし、成功した本数を返す
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
			// biome-ignore lint/plugin: 1本の失敗で残りの動画取得を止めない
		} catch (e) {
			console.warn(`  [yt-dlp] ${url} 失敗: ${(e as Error).message}`);
		}
	}
	return ok;
}

/**
 * videos/ 配下のファイルから動画 ID をキー, ファイル名を値とするマップを構築する
 * ディレクトリが無い場合やダウンロード失敗時は空になる
 */
export async function buildLocalVideoMap(
	videosDir: string,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	let files: string[];
	try {
		files = await readdir(videosDir);
	} catch {
		return map;
	}
	for (const f of files) {
		const dot = f.lastIndexOf(".");
		const id = dot > 0 ? f.slice(0, dot) : f;
		if (id) map.set(id, f);
	}
	return map;
}

/**
 * HTML 内の YouTube iframe/figure 埋め込みをローカルの <video> と元動画リンクに置換する
 * 置換が無い場合は元の HTML をそのまま返す
 */
export function rewriteYoutubeEmbedsToLocal(
	html: string,
	videosDirRel: string,
	fileMap: Map<string, string>,
): string {
	if (fileMap.size === 0) return html;
	const root = parseHTML(html);
	let replaced = 0;

	const swap = (id: string): string => {
		const file = fileMap.get(id);
		if (!file) return "";
		const watchUrl = `https://www.youtube.com/watch?v=${id}`;
		return `<div class="local-yt-embed" style="margin:1em 0"><video controls preload="metadata" src="${videosDirRel}/${file}" style="max-width:100%;display:block"></video><p style="margin:.4em 0;font-size:.9em"><a href="${watchUrl}" target="_blank" rel="noopener">YouTube で開く</a></p></div>`;
	};

	for (const el of root.querySelectorAll("iframe, embed")) {
		const src = el.getAttribute("src") ?? "";
		const id = extractYoutubeId(src);
		if (!id || !fileMap.has(id)) continue;
		el.replaceWith(swap(id));
		replaced++;
	}
	// note.com の <figure embedded-service="youtube" data-src="..."> も置換
	for (const el of root.querySelectorAll('[embedded-service="youtube"]')) {
		const src = el.getAttribute("data-src") ?? el.getAttribute("src") ?? "";
		const id = extractYoutubeId(src);
		if (!id || !fileMap.has(id)) continue;
		el.replaceWith(swap(id));
		replaced++;
	}

	return replaced > 0 ? root.toString() : html;
}
