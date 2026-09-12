import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { type HTMLElement, parse as parseHTML } from "node-html-parser";
import TurndownService from "turndown";
import type { NoteClient } from "./api";

/**
 * MIME から拡張子へのフォールバックマップ
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
 * URL のパス末尾と Content-Type から保存時の拡張子を決める
 * パス側の拡張子を優先し、無ければ MIME マップ、それも無ければ .bin
 */
function extFor(url: string, contentType: string): string {
	const e = extname(new URL(url, "https://note.com").pathname).toLowerCase();
	if (e !== "" && e.length <= 5) return e;
	const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return EXT_BY_MIME[mime] ?? ".bin";
}

/**
 * SHA-1 を 10 文字に切り詰めた短縮ハッシュ (画像ファイル名用)
 */
function shortHash(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

/**
 * img から実際に参照すべき URL を選ぶ
 * src が data: でないときは src、それ以外は遅延読み込み用の属性を優先する
 */
function pickImageSource(img: HTMLElement): string | undefined {
	const src = img.getAttribute("src");
	if (src && !src.startsWith("data:")) return src;
	return (
		img.getAttribute("data-src") ?? img.getAttribute("data-original-src") ?? src
	);
}

/**
 * 遅延読み込み用の属性も見て画像の絶対 URL を求める
 * 解決できない場合と data: 画像の場合は undefined
 */
function imageUrl(img: HTMLElement): string | undefined {
	const src = pickImageSource(img);
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
 * 画像を DL して保存ファイル名を返す
 * cache 済みなら DL せずその名前を返し、失敗時の処理は呼び出し側に委ねる
 */
async function resolveImageFilename(
	absUrl: string,
	imageDir: string,
	client: NoteClient,
	cache: Map<string, string> | undefined,
	ensureDir: () => Promise<void>,
): Promise<string> {
	const cached = cache?.get(absUrl);
	if (cached) return cached;
	const { buf, type } = await client.fetchBinary(absUrl);
	const filename = `${shortHash(absUrl)}${extFor(absUrl, type)}`;
	await ensureDir();
	await Bun.write(join(imageDir, filename), buf);
	cache?.set(absUrl, filename);
	return filename;
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
	let count = 0;
	let dirReady = false;

	const ensureDir = async (): Promise<void> => {
		if (dirReady) return;
		await mkdir(imageDir, { recursive: true });
		dirReady = true;
	};

	for (const img of root.querySelectorAll("img")) {
		const absUrl = imageUrl(img);
		if (!absUrl) continue;
		try {
			const filename = await resolveImageFilename(
				absUrl,
				imageDir,
				client,
				cache,
				ensureDir,
			);
			applyLocalSrc(img, filename);
			count++;
			// biome-ignore lint/plugin: 画像1枚の失敗で記事全体を止めず、残りの画像を継続する
		} catch (e) {
			console.warn(`  [img] ${absUrl} 失敗: ${(e as Error).message}`);
		}
	}

	return { html: root.toString(), count };
}

/**
 * Turndown で HTML を Markdown 化する
 * iframe/embed は `[embed](url)`、figure は前後改行で囲むカスタムルールを追加する
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
			if (!("getAttribute" in node)) return "";
			const src = node.getAttribute("src") ?? "";
			return src ? `\n\n[embed](${src})\n\n` : "";
		},
	});
	td.addRule("figure", {
		filter: "figure",
		replacement: (content) => `\n\n${content}\n\n`,
	});
	return td.turndown(html).trim();
}
