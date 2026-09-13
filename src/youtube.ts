import { mkdir, readdir } from "node:fs/promises";
import { extname } from "node:path";
import { type HTMLElement, parse as parseHTML } from "node-html-parser";

/**
 * 相対 URL を解決するときの基準オリジン
 */
const URL_BASE = "https://note.com";

/**
 * note.com が YouTube 埋め込みに使う figure のセレクタ
 */
const YOUTUBE_EMBED_SELECTOR = '[embedded-service="youtube"]';

/**
 * URL を基準オリジンで解決する
 * 解釈できない場合は undefined を返す
 */
function parseUrl(url: string): URL | undefined {
	try {
		return new URL(url, URL_BASE);
	} catch {
		return undefined;
	}
}

/**
 * ホスト名から先頭の www. を除く
 */
function stripWww(hostname: string): string {
	return hostname.replace(/^www\./, "");
}

/**
 * pathname から prefix 直後の最初のパス要素を取り出す
 * 取り出せない場合は undefined を返す
 */
function pathSegment(pathname: string, prefix: string): string | undefined {
	return pathname.slice(prefix.length).split("/")[0] || undefined;
}

/**
 * URL から YouTube 動画 ID を抽出する
 *
 * @param url - 抽出元の URL
 */
export function extractYoutubeId(url: string): string | undefined {
	const u = parseUrl(url);
	if (!u) return undefined;
	if (stripWww(u.hostname) === "youtu.be") return pathSegment(u.pathname, "/");
	if (u.pathname.startsWith("/embed/")) {
		return pathSegment(u.pathname, "/embed/");
	}
	if (u.pathname.startsWith("/shorts/")) {
		return pathSegment(u.pathname, "/shorts/");
	}
	if (u.pathname === "/watch") return u.searchParams.get("v") ?? undefined;
	return undefined;
}

/**
 * YouTube のホストかどうかを判定する
 */
function isYoutube(url: string): boolean {
	const u = parseUrl(url);
	if (!u) return false;
	const host = stripWww(u.hostname);
	return (
		host === "youtube.com" ||
		host === "youtu.be" ||
		host === "youtube-nocookie.com" ||
		host.endsWith(".youtube.com")
	);
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
 * 要素が持つ属性のうち、最初に定義されている値を返す
 * すべて未定義なら空文字を返す
 */
function pickAttribute(el: HTMLElement, attributes: string[]): string {
	for (const name of attributes) {
		const value = el.getAttribute(name);
		if (value !== undefined) return value;
	}
	return "";
}

/**
 * 指定セレクタの要素から YouTube URL を重複なく集める
 * attributes は先に書いた属性を優先する
 */
function collectYoutubeUrls(
	root: HTMLElement,
	selector: string,
	attributes: string[],
	out: Set<string>,
): void {
	for (const el of root.querySelectorAll(selector)) {
		const raw = pickAttribute(el, attributes);
		if (raw && isYoutube(raw)) out.add(normalizeYoutube(raw));
	}
}

/**
 * 本文 HTML から YouTube 動画 URL を重複なく抽出する
 *
 * @param bodyHtml - 本文 HTML
 */
export function extractYoutubeUrls(bodyHtml: string): string[] {
	const root = parseHTML(bodyHtml);
	const out = new Set<string>();
	// note.com の埋め込みは <figure data-src="..." embedded-service="youtube"> 形式
	collectYoutubeUrls(root, YOUTUBE_EMBED_SELECTOR, ["data-src", "src"], out);
	// 一般的な iframe/embed 直書き (他サイトからのコピペ等)
	collectYoutubeUrls(root, "iframe, embed", ["src"], out);
	// 本文内のテキストリンク
	collectYoutubeUrls(root, "a", ["href"], out);
	return Array.from(out);
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
 *
 * @param urls - ダウンロード対象の URL
 * @param outDir - 動画の保存先ディレクトリ
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
	let downloaded = 0;
	for (const url of urls) {
		try {
			await runYtDlp(url, outDir);
			downloaded++;
			// biome-ignore lint/plugin: 1本の失敗で残りの動画取得を止めない
		} catch (e) {
			console.warn(`  [yt-dlp] ${url} 失敗: ${(e as Error).message}`);
		}
	}
	return downloaded;
}

/**
 * videos/ 配下のファイルから動画 ID をキー, ファイル名を値とするマップを構築する
 * ディレクトリが無い場合やダウンロード失敗時は空になる
 *
 * @param videosDir - videos/ のパス
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
	for (const file of files) {
		const ext = extname(file);
		const id = ext ? file.slice(0, -ext.length) : file;
		if (id) map.set(id, file);
	}
	return map;
}

/**
 * ローカルの <video> と元動画リンクからなる埋め込み HTML を組み立てる
 */
function localEmbedHtml(
	id: string,
	file: string,
	videosDirRel: string,
): string {
	const watchUrl = `https://www.youtube.com/watch?v=${id}`;
	return `<div class="local-yt-embed" style="margin:1em 0"><video controls preload="metadata" src="${videosDirRel}/${file}" style="max-width:100%;display:block"></video><p style="margin:.4em 0;font-size:.9em"><a href="${watchUrl}" target="_blank" rel="noopener">YouTube で開く</a></p></div>`;
}

/**
 * HTML 内の YouTube iframe/figure 埋め込みをローカルの <video> と元動画リンクに置換する
 * 置換が無い場合は元の HTML をそのまま返す
 *
 * @param html - 置換対象の HTML
 * @param videosDirRel - 動画ディレクトリへの相対パス
 * @param fileMap - 動画 ID からファイル名へのマップ
 */
export function rewriteYoutubeEmbedsToLocal(
	html: string,
	videosDirRel: string,
	fileMap: Map<string, string>,
): string {
	if (fileMap.size === 0) return html;
	const root = parseHTML(html);
	let replaced = 0;

	const replacementFor = (id: string): string => {
		const file = fileMap.get(id);
		if (!file) return "";
		return localEmbedHtml(id, file, videosDirRel);
	};

	const replaceEmbeds = (selector: string, attributes: string[]): void => {
		for (const el of root.querySelectorAll(selector)) {
			const id = extractYoutubeId(pickAttribute(el, attributes));
			if (!id || !fileMap.has(id)) continue;
			el.replaceWith(replacementFor(id));
			replaced++;
		}
	};

	replaceEmbeds("iframe, embed", ["src"]);
	// note.com の <figure embedded-service="youtube" data-src="..."> も置換
	replaceEmbeds(YOUTUBE_EMBED_SELECTOR, ["data-src", "src"]);

	return replaced > 0 ? root.toString() : html;
}
