import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseHTML } from "node-html-parser";
import TurndownService from "turndown";
import type { NoteClient } from "./api";

export interface RenderResult {
	markdown: string;
	imageCount: number;
}

const EXT_BY_MIME: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/avif": ".avif",
};

function extFor(url: string, contentType: string): string {
	const e = extname(new URL(url, "https://note.com").pathname).toLowerCase();
	if (e !== "" && e.length <= 5) return e;
	const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return EXT_BY_MIME[mime] ?? ".bin";
}

function shortHash(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

export async function downloadImagesAndRewrite(
	bodyHtml: string,
	imageDir: string,
	client: NoteClient,
): Promise<{ html: string; count: number }> {
	const root = parseHTML(bodyHtml);
	const imgs = root.querySelectorAll("img");
	let count = 0;

	await mkdir(imageDir, { recursive: true });

	for (const img of imgs) {
		const src =
			img.getAttribute("src") ??
			img.getAttribute("data-src") ??
			img.getAttribute("data-original-src");
		if (!src || src.startsWith("data:")) continue;

		const absUrl = src.startsWith("http") ? src : `https:${src}`;
		try {
			const { buf, type } = await client.fetchBinary(absUrl);
			const ext = extFor(absUrl, type);
			const filename = `${shortHash(absUrl)}${ext}`;
			await writeFile(join(imageDir, filename), Buffer.from(buf));
			img.setAttribute("src", `images/${filename}`);
			img.removeAttribute("data-src");
			img.removeAttribute("srcset");
			count++;
		} catch (e) {
			console.warn(`  [img] ${absUrl} 失敗: ${(e as Error).message}`);
		}
	}

	return { html: root.toString(), count };
}

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
