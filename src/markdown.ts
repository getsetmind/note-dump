import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { type HTMLElement, parse as parseHTML } from "node-html-parser";
import TurndownService from "turndown";
import type { NoteClient } from "./api";

/**
 * @description MIME から拡張子へのフォールバックマップ
 */
const EXT_BY_MIME: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/avif": ".avif",
};

/**
 * @description URL のパス末尾と Content-Type から保存時の拡張子を決める
 *   パス側の拡張子を優先し、無ければ MIME マップ、それも無ければ .bin
 */
function extFor(url: string, contentType: string): string {
	const e = extname(new URL(url, "https://note.com").pathname).toLowerCase();
	if (e !== "" && e.length <= 5) return e;
	const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return EXT_BY_MIME[mime] ?? ".bin";
}

/**
 * @description SHA-1 を 10 文字に切り詰めた短縮ハッシュ (画像ファイル名用)
 */
function shortHash(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

/**
 * 遅延読み込み用の属性も見て画像の絶対 URL を求める
 * 解決できない場合と data: 画像の場合は undefined
 */
function imageUrl(img: HTMLElement): string | undefined {
	const rawSrc = img.getAttribute("src");
	const dataSrc =
		img.getAttribute("data-src") ?? img.getAttribute("data-original-src");
	const src =
		rawSrc && !rawSrc.startsWith("data:") ? rawSrc : (dataSrc ?? rawSrc);
	if (!src || src.startsWith("data:")) return undefined;
	return src.startsWith("http") ? src : `https:${src}`;
}

/**
 * img をローカル画像へ向け、遅延読み込み用の属性を落とす
 */
function applyLocalSrc(img: HTMLElement, filename: string): void {
	img.setAttribute("src", `images/${filename}`);
	img.removeAttribute("data-src");
	img.removeAttribute("srcset");
}

/**
 * 本文 HTML 内の画像を DL してローカル参照に書き換える
 * cache を渡すと同一記事内の再取得を省ける
 */
export async function downloadImagesAndRewrite(
	bodyHtml: string,
	imageDir: string,
	client: NoteClient,
	cache?: Map<string, string>,
): Promise<{ html: string; count: number }> {
	const root = parseHTML(bodyHtml);
	const imgs = root.querySelectorAll("img");
	let count = 0;
	let dirReady = false;

	const ensureDir = async (): Promise<void> => {
		if (dirReady) return;
		await mkdir(imageDir, { recursive: true });
		dirReady = true;
	};

	for (const img of imgs) {
		const absUrl = imageUrl(img);
		if (!absUrl) continue;

		const cached = cache?.get(absUrl);
		if (cached) {
			applyLocalSrc(img, cached);
			count++;
			continue;
		}

		try {
			const { buf, type } = await client.fetchBinary(absUrl);
			const filename = `${shortHash(absUrl)}${extFor(absUrl, type)}`;
			await ensureDir();
			await Bun.write(join(imageDir, filename), buf);
			applyLocalSrc(img, filename);
			cache?.set(absUrl, filename);
			count++;
		} catch (e) {
			console.warn(`  [img] ${absUrl} 失敗: ${(e as Error).message}`);
		}
	}

	return { html: root.toString(), count };
}

/**
 * @description Turndown で HTML を Markdown 化
 *   iframe/embed は `[embed](url)`、figure は前後改行で囲むカスタムルールを追加
 */
export function htmlToMarkdown(html: string): string {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "_",
	});
	td.addRule("noteEmbed", {
		filter: (node) => {
			const tag = node.nodeName.toLowerCase();
			return tag === "iframe" || tag === "embed";
		},
		replacement: (_content, node) => {
			const el = node as unknown as {
				getAttribute: (n: string) => string | null;
			};
			const src = el.getAttribute("src") ?? "";
			return src ? `\n\n[embed](${src})\n\n` : "";
		},
	});
	td.addRule("figure", {
		filter: "figure",
		replacement: (content) => `\n\n${content}\n\n`,
	});
	return td.turndown(html).trim();
}
