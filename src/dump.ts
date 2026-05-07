import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NoteClient, type NoteRef, parseUrlOrKey } from "./api";
import { loadConfig } from "./config";
import { downloadImagesAndRewrite, htmlToMarkdown } from "./markdown";

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
	outDir: string,
): Promise<void> {
	const detail = await client.fetchNote(ref.key);
	const slug = sanitizeFilename(detail.name) || detail.key;
	const dir = join(outDir, `${detail.key}_${slug}`);
	await mkdir(dir, { recursive: true });

	const { html, count } = await downloadImagesAndRewrite(
		detail.body,
		join(dir, "images"),
		client,
	);

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
	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify(detail.raw, null, 2),
		"utf8",
	);
	console.log(`  -> ${dir}  (images: ${count})`);
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
	if (cfg.mode === "file") {
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
		await dumpOne(client, ref, cfg.outDir);
	});

	console.log(`[dump] 完了。出力先: ${cfg.outDir}`);
}

main().catch((e: Error) => {
	console.error(e.stack ?? e.message);
	process.exit(1);
});
