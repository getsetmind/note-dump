import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { type HTMLElement, parse } from "node-html-parser";
import type { NoteClient, NoteDetail } from "./api";

/**
 * 本文コンテナの候補を新旧のページ構造に合わせて試す
 */
const BODY_SELECTORS = [
	"#note-body",
	".note-common-styles__textnote-body",
	".p-article__body",
	".o-noteContentText",
	'[data-name="body"]',
];

/**
 * HTTP(S) 参照だけを基準 URL から解決する
 */
function resourceUrl(value: string, base: string): string | undefined {
	if (!URL.canParse(value, base)) return undefined;
	const url = new URL(value, base);
	return /^https?:$/.test(url.protocol) ? url.href : undefined;
}

/**
 * 外部 CSS と参照アセットを記事ごとの assets ディレクトリに保存する
 */
class StyleArchive {
	private readonly saved = new Map<string, string>();

	/**
	 * 保存先と Cookie 不要のアセット取得クライアントを受け取る
	 */
	constructor(
		private readonly dir: string,
		private readonly client: NoteClient,
	) {}

	/**
	 * CSS の url() と引用符付き @import を保存済み参照に書き換える
	 */
	async rewrite(css: string, base: string, prefix: string): Promise<string> {
		const pattern =
			/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+(["'])(.*?)\4/gi;
		let result = "";
		let cursor = 0;
		for (const match of css.matchAll(pattern)) {
			result += css.slice(cursor, match.index);
			const value = match[1] ?? match[2] ?? match[3] ?? match[5] ?? "";
			const url =
				value && !value.startsWith("#") ? resourceUrl(value, base) : undefined;
			if (!url) {
				result += match[0];
			} else {
				const isImport =
					match[4] !== undefined ||
					/@import\s*$/i.test(
						css.slice(Math.max(0, match.index - 20), match.index),
					);
				const parsed = new URL(url);
				const fragment = parsed.hash;
				parsed.hash = "";
				const filename = await this.save(parsed.href, isImport);
				const target = filename ? `${prefix}${filename}${fragment}` : url;
				result += match[4] ? `@import "${target}"` : `url("${target}")`;
			}
			cursor = match.index + match[0].length;
		}
		return result + css.slice(cursor);
	}

	/**
	 * 循環 import をキャッシュで止め、失敗した参照はオンライン URL に戻す
	 */
	async save(url: string, stylesheet: boolean): Promise<string | undefined> {
		const cached = this.saved.get(url);
		if (cached) return cached;
		try {
			const { buf, type } = await this.client.fetchBinary(url);
			const css = stylesheet || type.split(";")[0] === "text/css";
			const extension = css ? ".css" : extname(new URL(url).pathname) || ".bin";
			const filename = `${createHash("sha1").update(url).digest("hex").slice(0, 16)}${extension}`;
			this.saved.set(url, filename);
			await mkdir(join(this.dir, "assets"), { recursive: true });
			const content = css
				? await this.rewrite(new TextDecoder().decode(buf), url, "")
				: buf;
			await Bun.write(join(this.dir, "assets", filename), content);
			return filename;
		} catch (error) {
			this.saved.delete(url);
			console.warn(
				`[snapshot] アセット取得失敗: ${url}: ${(error as Error).message}`,
			);
			return undefined;
		}
	}
}

/**
 * 本文の一致を確認して SSR の画像・段落の表示用 HTML を引き継ぐ
 */
function preserveRenderedBlocks(
	container: HTMLElement,
	replacement: HTMLElement,
): void {
	const blocks = new Map(
		container.querySelectorAll("[id]").map((element) => [element.id, element]),
	);
	for (const element of replacement.querySelectorAll("[id]")) {
		const existing = blocks.get(element.id);
		if (existing && equivalentBlock(element, existing))
			element.replaceWith(existing.outerHTML);
	}
}

/**
 * プレビューや古い本文を引き継がないよう、文字列と画像の実体を照合する
 */
function equivalentBlock(
	original: HTMLElement,
	rendered: HTMLElement,
): boolean {
	if (
		original.tagName !== rendered.tagName ||
		original.text.replace(/\s/g, "") !== rendered.text.replace(/\s/g, "")
	)
		return false;
	const imageKeys = (element: HTMLElement): string =>
		element
			.querySelectorAll("img")
			.map((img) => {
				const src =
					img.getAttribute("data-src") ?? img.getAttribute("src") ?? "";
				const url = resourceUrl(src, "https://note.com/");
				return url ? new URL(url).origin + new URL(url).pathname : src;
			})
			.join("\n");
	return imageKeys(original) === imageKeys(rendered);
}

/**
 * 元ページの目次のスタイルに、購入済み本文の全見出しを組み込む
 */
function restoreContents(
	replacement: HTMLElement,
	container: HTMLElement,
): void {
	const headings = replacement.querySelectorAll("h2, h3");
	const template = container.querySelector('nav[aria-label="目次"]');
	for (const placeholder of replacement.querySelectorAll("table-of-contents")) {
		const nav = parse(
			template?.outerHTML ??
				'<nav aria-label="目次" class="mt-9"><details open class="group bg-background-secondary p-4"><summary>目次</summary><ol></ol></details></nav>',
		).querySelector("nav");
		const list = nav?.querySelector("ol");
		if (!nav || !list) continue;
		const itemClass =
			list
				.querySelector("li")
				?.getAttribute("class")
				?.replace(/\bml-4\b/g, "") ?? "py-2 text-sm";
		list.set_content("");
		fillContents(list, headings, itemClass);
		for (const button of nav.querySelectorAll("button"))
			button.parentNode?.remove();
		placeholder.replaceWith(nav);
	}
}

/**
 * 全見出しへのローカルアンカーを目次に追加する
 */
function fillContents(
	list: HTMLElement,
	headings: HTMLElement[],
	itemClass: string,
): void {
	for (const [index, heading] of headings.entries()) {
		const id = heading.id || `note-dump-heading-${index}`;
		heading.setAttribute("id", id);
		const item = parse('<li><a class="!no-underline"></a></li>').querySelector(
			"li",
		);
		const link = item?.querySelector("a");
		if (!item || !link) continue;
		item.setAttribute(
			"class",
			`${itemClass}${heading.tagName === "H3" ? " ml-4" : ""}`,
		);
		link.setAttribute("href", `#${id}`);
		link.textContent = heading.text;
		list.appendChild(item);
	}
}

/**
 * React のストリーミング SSR で後送された HTML を対応する境界へ移す
 * スクリプトは実行せず、明示された template と hidden セグメントを対応させる
 */
function restoreStreamedContent(root: HTMLElement): void {
	const templates = new Map(
		root
			.querySelectorAll("template[id]")
			.map((element) => [element.id, element]),
	);
	for (const segment of root.querySelectorAll("[hidden][id]")) {
		if (!segment.id.startsWith("S:")) continue;
		const template = templates.get(`B:${segment.id.slice(2)}`);
		if (!template) continue;
		removeBoundaryFallback(template);
		template.replaceWith(...segment.childNodes);
		segment.remove();
	}
}

/**
 * ストリーミング境界の fallback だけを、入れ子の終端を数えて取り除く
 */
function removeBoundaryFallback(template: HTMLElement): void {
	const siblings = template.parentNode?.childNodes ?? [];
	const index = siblings.indexOf(template);
	if (siblings[index - 1]?.rawText !== "$?") return;
	let depth = 0;
	const fallback = [];
	for (const node of siblings.slice(index + 1)) {
		if (node.nodeType === 8 && node.rawText === "/$") {
			if (depth === 0) {
				fallback.forEach((item) => {
					item.remove();
				});
				return;
			}
			depth--;
		} else if (node.nodeType === 8 && /^\$(?:[?!])?$/.test(node.rawText))
			depth++;
		fallback.push(node);
	}
}

/**
 * API 本文を正とし、画像・目次・展開済み埋め込みの SSR 装飾を引き継ぐ
 */
function replaceBody(container: HTMLElement, body: string): void {
	const rendered = new Map<string, string>();
	for (const figure of container.querySelectorAll(
		"figure[embedded-content-key]",
	)) {
		const key = figure.getAttribute("embedded-content-key");
		if (key) rendered.set(key, figure.innerHTML);
	}
	const replacement = parse(body);
	preserveRenderedBlocks(container, replacement);
	restoreContents(replacement, container);
	for (const figure of replacement.querySelectorAll(
		"figure[embedded-content-key]",
	)) {
		const key = figure.getAttribute("embedded-content-key");
		const existing = key ? rendered.get(key) : undefined;
		if (existing) figure.set_content(existing);
	}
	restoreAttachmentLayout(replacement);
	container.set_content(replacement.toString());
}

/**
 * SSR にない購入部分の添付ファイルも、既存 CSS の余白とファイル名表示を使う
 */
function restoreAttachmentLayout(root: HTMLElement): void {
	for (const figure of root.querySelectorAll(
		'[embedded-service="attachment"]',
	)) {
		if (figure.querySelector(".file-widget__link")) continue;
		const link = figure.querySelector('a[href*="/attachments/download/"]');
		if (!link) continue;
		link.classList.add("file-widget__link");
		link.querySelector("strong")?.classList.add("file-widget__filename");
		const content = link.innerHTML;
		link.set_content(
			`<div class="file-widget__info"><div class="file-widget__data" style="white-space:pre-line">${content}</div></div>`,
		);
	}
}

/**
 * lazy-load 参照を有効にし、空の埋め込みには元 URL へのリンクを置く
 */
function restoreLazyContent(root: HTMLElement, articleUrl: string): void {
	for (const element of root.querySelectorAll("img, iframe, embed")) {
		const lazy =
			element.getAttribute("data-src") ??
			element.getAttribute("data-original-src");
		if (lazy) element.setAttribute("src", lazy);
		const src = element.getAttribute("src");
		if (src) element.setAttribute("src", new URL(src, articleUrl).href);
		if (element.tagName === "IFRAME") {
			const style = element.getAttribute("style") ?? "";
			element.setAttribute(
				"style",
				style.replace(/visibility\s*:\s*hidden/gi, "visibility:visible"),
			);
		}
	}
	restoreEmptyEmbeds(root, articleUrl);
}

/**
 * SSR で未展開の埋め込みは元 URL へのリンクとして残す
 */
function restoreEmptyEmbeds(root: HTMLElement, articleUrl: string): void {
	for (const figure of root.querySelectorAll("figure[data-src]")) {
		if (figure.querySelector("iframe, img, embed, a")) continue;
		const url = resourceUrl(figure.getAttribute("data-src") ?? "", articleUrl);
		if (!url) continue;
		const link = parse('<a target="_blank" rel="noopener"></a>').querySelector(
			"a",
		);
		if (!link) continue;
		link.setAttribute("href", url);
		link.textContent = url;
		figure.appendChild(link);
	}
}

/**
 * スクリプト、ログイン UI、購入案内、不要なリソースヒントを除去する
 */
function cleanPage(root: HTMLElement): void {
	for (const node of root.querySelectorAll(
		'script, noscript, header, base, #note-paywall, .note-paywall, [data-testid="note-body-gradient-overlay"]',
	))
		node.remove();
	for (const node of root.querySelectorAll("meta[http-equiv], link")) {
		if (
			node.tagName === "META" ||
			/^(preload|modulepreload|prefetch|preconnect|dns-prefetch)$/i.test(
				node.getAttribute("rel") ?? "",
			)
		)
			node.remove();
	}
	cleanLoadingUi(root);
	cleanInactiveControls(root);
}

/**
 * スクリプト依存の本文外ボタンと、空になった固定バーを取り除く
 */
function cleanInactiveControls(root: HTMLElement): void {
	for (const button of root.querySelectorAll("button")) {
		if (!button.closest(BODY_SELECTORS.join(", "))) button.remove();
	}
	for (const node of root.querySelectorAll(".fixed")) {
		if (
			node.closest(BODY_SELECTORS.join(", ")) ||
			node.text.trim() ||
			node.querySelector("a, img, svg, input, iframe, video")
		)
			continue;
		node.remove();
	}
}

/**
 * JavaScript がないと残り続ける本文外の空スケルトンと読み込み表示を取り除く
 */
function cleanLoadingUi(root: HTMLElement): void {
	for (const node of root.querySelectorAll(".bg-surface-quaternary")) {
		if (
			node.closest(BODY_SELECTORS.join(", ")) ||
			node.text.trim() ||
			node.querySelector("img")
		)
			continue;
		node.remove();
	}
	for (const node of root.querySelectorAll(".animate-pulse")) {
		const aside = node.closest("aside");
		if (aside && !aside.text.trim() && !aside.querySelector("img, a"))
			aside.remove();
	}
	for (const heading of root.querySelectorAll("h2")) {
		if (heading.text !== "あなたへのおすすめ") continue;
		const section = heading.closest(".divide-y");
		if (section && !section.querySelector("a")) section.parentNode?.remove();
	}
}

/**
 * イベント属性を除去し、ナビゲーションとメディア参照を絶対 URL にする
 */
function resolvePageUrls(root: HTMLElement, articleUrl: string): void {
	for (const element of root.querySelectorAll("*")) {
		for (const attribute of Object.keys(element.attributes)) {
			if (/^on/i.test(attribute)) element.removeAttribute(attribute);
		}
		resolveElementUrls(element, articleUrl);
	}
}

/**
 * 1 要素の相対参照を絶対参照へ書き換える
 */
function resolveElementUrls(element: HTMLElement, articleUrl: string): void {
	for (const attribute of ["href", "action", "poster"]) {
		const value = element.getAttribute(attribute);
		if (!value || value.startsWith("#")) continue;
		const url = resourceUrl(value, articleUrl);
		if (url) element.setAttribute(attribute, url);
		else if (/^javascript:/i.test(value)) element.removeAttribute(attribute);
	}
}

/**
 * ページ内の外部 CSS とインライン CSS をローカルアセットへ向ける
 */
async function archiveStyles(
	root: HTMLElement,
	articleUrl: string,
	archive: StyleArchive,
): Promise<void> {
	for (const link of root.querySelectorAll('link[rel="stylesheet"]')) {
		const href = link.getAttribute("href");
		if (!href) continue;
		const filename = await archive.save(href, true);
		if (filename) {
			link.setAttribute("href", `assets/${filename}`);
			link.removeAttribute("integrity");
			link.removeAttribute("crossorigin");
		}
	}
	for (const style of root.querySelectorAll("style")) {
		style.set_content(
			await archive.rewrite(style.innerHTML, articleUrl, "assets/"),
		);
	}
	for (const element of root.querySelectorAll("[style]")) {
		const style = element.getAttribute("style") ?? "";
		if (/url\(/i.test(style))
			element.setAttribute(
				"style",
				await archive.rewrite(style, articleUrl, "assets/"),
			);
	}
}

/**
 * HTML を直接取得し、元のレイアウトと CSS に購入済み本文を組み込む
 * 本文コンテナが見つからなければ、黙ってプレビューを保存せず失敗を伝える
 *
 * @param client - 記事とアセットの取得クライアント
 * @param articleUrl - 著者名を含む記事 URL
 * @param detail - 認証済み API で取得した記事本文
 * @param dir - 記事の保存先
 */
export async function captureHttpHtml(
	client: NoteClient,
	articleUrl: string,
	detail: NoteDetail,
	dir: string,
): Promise<string> {
	const root = parse(await client.getText(articleUrl, "text/html"), {
		comment: true,
	});
	restoreStreamedContent(root);
	const container = BODY_SELECTORS.map((selector) =>
		root.querySelector(selector),
	).find(Boolean);
	if (!container || !detail.body.trim()) {
		throw new Error(
			"[snapshot] 記事本文が見つかりません。Cookie と記事 URL を確認してください。",
		);
	}
	replaceBody(container, detail.body);
	cleanPage(root);
	resolvePageUrls(root, articleUrl);
	restoreLazyContent(root, articleUrl);
	await archiveStyles(root, articleUrl, new StyleArchive(dir, client));
	return root.toString();
}
