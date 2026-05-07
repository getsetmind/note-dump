import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NoteClient, type NoteRef, parseUrlOrKey } from "./api";
import { type Config, loadConfig } from "./config";
import { downloadImagesAndRewrite, htmlToMarkdown } from "./markdown";
import { captureRenderedHtml } from "./snapshot";
import {
	buildLocalVideoMap,
	downloadYoutubeAll,
	extractYoutubeUrls,
	rewriteYoutubeEmbedsToLocal,
} from "./youtube";

function sanitizeFilename(s: string): string {
	return s
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

async function dumpOne(
	client: NoteClient,
	ref: NoteRef,
	cfg: Config,
): Promise<void> {
	const detail = await client.fetchNote(ref.key);
	const slug = sanitizeFilename(detail.name) || detail.key;
	const dir = join(cfg.outDir, `${detail.key}_${slug}`);
	await mkdir(dir, { recursive: true });

	const wantMd = cfg.format === "md" || cfg.format === "both";
	const wantHtml = cfg.format === "html" || cfg.format === "both";

	let imageCount = 0;
	if (wantMd) {
		const { html, count } = await downloadImagesAndRewrite(
			detail.body,
			join(dir, "images"),
			client,
		);
		imageCount = count;

		const fm = [
			"---",
			`key: ${detail.key}`,
			`title: ${JSON.stringify(detail.name)}`,
			`url: ${ref.url}`,
			detail.user ? `creator: ${detail.user.urlname}` : undefined,
			detail.user
				? `creator_name: ${JSON.stringify(detail.user.nickname)}`
				: undefined,
			detail.publishAt ? `publish_at: ${detail.publishAt}` : undefined,
			detail.createdAt ? `created_at: ${detail.createdAt}` : undefined,
			detail.priceText ? `price: ${detail.priceText}` : undefined,
			`dumped_at: ${new Date().toISOString()}`,
			"---",
			"",
		]
			.filter((x) => x !== undefined)
			.join("\n");

		const md = `${fm}# ${detail.name}\n\n${htmlToMarkdown(html)}\n`;
		await writeFile(join(dir, "index.md"), md, "utf8");
	}

	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify(detail.raw, null, 2),
		"utf8",
	);

	// HTML 内で YouTube 埋め込みをローカル動画に差し替えるため、html 出力より先に DL する
	let ytCount = 0;
	if (cfg.youtubeDl) {
		const urls = extractYoutubeUrls(detail.body);
		if (urls.length > 0) {
			ytCount = await downloadYoutubeAll(urls, join(dir, "videos"));
		}
	}

	let htmlOk = false;
	let htmlImages = 0;
	if (wantHtml) {
		// note.com/n/<key> は 404 になるため urlname 込みで再構築する
		const articleUrl = detail.user?.urlname
			? `https://note.com/${detail.user.urlname}/n/${detail.key}`
			: ref.url;
		try {
			const captured = await captureRenderedHtml(cfg.cdpUrl, articleUrl);
			// downloadImagesAndRewrite で <img> を images/ にローカル化 (md と共有)
			const r = await downloadImagesAndRewrite(
				captured,
				join(dir, "images"),
				client,
			);
			let finalHtml = r.html;
			if (cfg.youtubeDl) {
				const map = await buildLocalVideoMap(join(dir, "videos"));
				finalHtml = rewriteYoutubeEmbedsToLocal(finalHtml, "videos", map);
			}
			await writeFile(join(dir, "page.html"), finalHtml, "utf8");
			htmlImages = r.count;
			htmlOk = true;
		} catch (e) {
			console.warn(`  [snapshot] 失敗: ${(e as Error).message}`);
		}
	}

	const parts: string[] = [];
	if (wantMd) parts.push(`images: ${imageCount}`);
	if (wantHtml)
		parts.push(`html: ${htmlOk ? `ok (+${htmlImages} img)` : "fail"}`);
	if (cfg.youtubeDl) parts.push(`youtube: ${ytCount}`);
	console.log(`  -> ${dir}  (${parts.join(", ")})`);
}

async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T, idx: number) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const runners = Array.from({ length: Math.max(1, limit) }, async () => {
		while (true) {
			const i = cursor++;
			if (i >= items.length) return;
			const item = items[i];
			if (item === undefined) return;
			try {
				await worker(item, i);
			} catch (e) {
				console.error(`[dump] item #${i} 失敗: ${(e as Error).message}`);
			}
		}
	});
	await Promise.all(runners);
}

function readUrlsFile(path: string): NoteRef[] {
	if (!existsSync(path)) {
		throw new Error(`urls ファイルが見つからない: ${path}`);
	}
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	const refs: NoteRef[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const key = parseUrlOrKey(line);
		if (!key) {
			console.warn(`[dump] 無視: ${line}`);
			continue;
		}
		refs.push({
			key,
			url: line.startsWith("http") ? line : `https://note.com/n/${key}`,
			title: undefined,
			creatorUrlname: undefined,
		});
	}
	return refs;
}

async function main(): Promise<void> {
	const cfg = loadConfig(process.argv.slice(2));
	const client = new NoteClient(cfg.cookie, cfg.requestDelayMs);
	await mkdir(cfg.outDir, { recursive: true });

	let refs: NoteRef[];
	if (cfg.mode === "args") {
		refs = [];
		for (const a of cfg.positional) {
			const key = parseUrlOrKey(a);
			if (!key) {
				console.warn(`[dump] 無視 (URL/key として解釈不能): ${a}`);
				continue;
			}
			refs.push({
				key,
				url: a.startsWith("http") ? a : `https://note.com/n/${key}`,
				title: undefined,
				creatorUrlname: undefined,
			});
		}
		console.log(`[dump] args モード: ${refs.length} 件`);
	} else if (cfg.mode === "file") {
		refs = readUrlsFile(cfg.urlsFile);
		console.log(`[dump] file モード: ${refs.length} 件`);
	} else {
		console.log("[dump] auto モード: 購入済み一覧を取得中…");
		refs = await client.fetchPurchasedKeys();
		console.log(`[dump] 取得: ${refs.length} 件`);
		const indexPath = join(cfg.outDir, "_index.json");
		await writeFile(indexPath, JSON.stringify(refs, null, 2), "utf8");
	}

	if (cfg.limit !== undefined) refs = refs.slice(0, cfg.limit);

	if (refs.length === 0) {
		console.log(
			"[dump] 対象0件。auto で取れない場合は --mode=file --urls=urls.txt を試してください。",
		);
		return;
	}

	let done = 0;
	await runWithConcurrency(refs, cfg.concurrency, async (ref) => {
		done++;
		console.log(`[${done}/${refs.length}] ${ref.key} ${ref.title ?? ""}`);
		await dumpOne(client, ref, cfg);
	});

	console.log(`[dump] 完了。出力先: ${cfg.outDir}`);
}

main().catch((e: Error) => {
	console.error(e.stack ?? e.message);
	process.exit(1);
});
