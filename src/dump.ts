import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	NoteClient,
	type NoteDetail,
	type NoteRef,
	parseUrlOrKey,
} from "./api";
import { type Config, loadConfig } from "./config";
import { downloadImagesAndRewrite, htmlToMarkdown } from "./markdown";
import { captureRenderedHtml } from "./snapshot";
import {
	buildLocalVideoMap,
	downloadYoutubeAll,
	extractYoutubeUrls,
	rewriteYoutubeEmbedsToLocal,
} from "./youtube";

/**
 * ファイル名に使えない文字を除去して 80 文字に丸める
 */
function sanitizeFilename(s: string): string {
	return s
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

/**
 * URL または note key 文字列から NoteRef を組み立てる
 * 解釈できない場合は undefined を返す
 */
function refFromInput(input: string): NoteRef | undefined {
	const key = parseUrlOrKey(input);
	if (!key) return undefined;
	return {
		key,
		url: input.startsWith("http") ? input : `https://note.com/n/${key}`,
		title: undefined,
		creatorUrlname: undefined,
	};
}

/**
 * frontmatter と本文を index.md へ書き出し、保存した画像の枚数を返す
 */
async function writeMarkdown(
	detail: NoteDetail,
	ref: NoteRef,
	dir: string,
	client: NoteClient,
	imageCache: Map<string, string>,
): Promise<number> {
	const { html, count } = await downloadImagesAndRewrite(
		detail.body,
		join(dir, "images"),
		client,
		imageCache,
	);
	const md = `${frontmatter(detail, ref)}# ${detail.name}\n\n${htmlToMarkdown(html)}\n`;
	await writeFile(join(dir, "index.md"), md, "utf8");
	return count;
}

/**
 * index.md 先頭の YAML frontmatter を組み立てる
 */
function frontmatter(detail: NoteDetail, ref: NoteRef): string {
	const lines = [
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
	];
	return lines.filter((x) => x !== undefined).join("\n");
}

/**
 * 本文の YouTube 埋め込みを videos ディレクトリへ保存し、本数を返す
 */
async function downloadVideos(
	detail: NoteDetail,
	dir: string,
): Promise<number> {
	const urls = extractYoutubeUrls(detail.body);
	if (urls.length === 0) return 0;
	return await downloadYoutubeAll(urls, join(dir, "videos"));
}

/**
 * CDP で描画した記事 HTML を page.html として保存する
 * 取得に失敗した場合は ok=false を返して warn のみで継続する
 */
async function writeRenderedHtml(
	detail: NoteDetail,
	ref: NoteRef,
	cfg: Config,
	dir: string,
	client: NoteClient,
	imageCache: Map<string, string>,
): Promise<{ ok: boolean; images: number }> {
	// note.com/n/<key> は 404 になるため urlname 込みで再構築する
	const articleUrl = detail.user?.urlname
		? `https://note.com/${detail.user.urlname}/n/${detail.key}`
		: ref.url;
	try {
		const captured = await captureRenderedHtml(cfg.cdpUrl, articleUrl);
		const { html, count } = await downloadImagesAndRewrite(
			captured,
			join(dir, "images"),
			client,
			imageCache,
		);
		let finalHtml = html;
		if (cfg.youtubeDl) {
			const map = await buildLocalVideoMap(join(dir, "videos"));
			finalHtml = rewriteYoutubeEmbedsToLocal(finalHtml, "videos", map);
		}
		await writeFile(join(dir, "page.html"), finalHtml, "utf8");
		return { ok: true, images: count };
	} catch (e) {
		console.warn(`  [snapshot] 失敗: ${(e as Error).message}`);
		return { ok: false, images: 0 };
	}
}

/**
 * dumpOne の結果を 1 行サマリに整形する
 */
function describeResult(
	wantMd: boolean,
	imageCount: number,
	htmlResult: { ok: boolean; images: number } | undefined,
	youtubeDl: boolean,
	youtubeCount: number,
): string {
	const parts: string[] = [];
	if (wantMd) parts.push(`images: ${imageCount}`);
	if (htmlResult) {
		parts.push(
			`html: ${htmlResult.ok ? `ok (+${htmlResult.images} img)` : "fail"}`,
		);
	}
	if (youtubeDl) parts.push(`youtube: ${youtubeCount}`);
	return parts.join(", ");
}

/**
 * 1 記事ぶんの取得と Markdown / HTML / 動画の書き出しをまとめて実行する
 */
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

	const imageCache = new Map<string, string>();

	const imageCount = wantMd
		? await writeMarkdown(detail, ref, dir, client, imageCache)
		: 0;

	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify(detail.raw, null, 2),
		"utf8",
	);

	// HTML 内で YouTube 埋め込みをローカル動画に差し替えるため、html 出力より先に DL する
	const ytCount = cfg.youtubeDl ? await downloadVideos(detail, dir) : 0;

	const htmlResult = wantHtml
		? await writeRenderedHtml(detail, ref, cfg, dir, client, imageCache)
		: undefined;

	const summary = describeResult(
		wantMd,
		imageCount,
		htmlResult,
		cfg.youtubeDl,
		ytCount,
	);
	console.log(`  -> ${dir}  (${summary})`);
}

/**
 * ワーカープール方式で worker を並列実行する
 * limit が 1 未満の場合は 1 として扱い、失敗は warn でスキップして残りを継続する
 */
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
				// biome-ignore lint/plugin: 1件の失敗で全体を止めず、残りのアイテムを継続する
			} catch (e) {
				console.error(`[dump] item #${i} 失敗: ${(e as Error).message}`);
			}
		}
	});
	await Promise.all(runners);
}

/**
 * 例外から errno code を取り出す
 * NodeJS.ErrnoException を assertion せず、実行時に code を検証する
 */
function errnoCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * urls.txt をパースして NoteRef の配列にする
 * 空行と '#' で始まるコメント行は無視する
 */
function readUrlsFile(path: string): NoteRef[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		if (errnoCode(e) === "ENOENT") {
			throw new Error(`urls ファイルが見つからない: ${path}`, { cause: e });
		}
		throw e;
	}
	const refs: NoteRef[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const ref = refFromInput(line);
		if (!ref) {
			console.warn(`[dump] 無視: ${line}`);
			continue;
		}
		refs.push(ref);
	}
	return refs;
}

/**
 * args モードの positional 引数を NoteRef に変換する
 * 解釈できない値は warn してスキップする
 */
function refsFromArgs(positional: string[]): NoteRef[] {
	const refs: NoteRef[] = [];
	for (const a of positional) {
		const ref = refFromInput(a);
		if (!ref) {
			console.warn(`[dump] 無視 (URL/key として解釈不能): ${a}`);
			continue;
		}
		refs.push(ref);
	}
	console.log(`[dump] args モード: ${refs.length} 件`);
	return refs;
}

/**
 * file モードの URL リストを読み込み、件数を表示する
 */
function refsFromUrlsFile(path: string): NoteRef[] {
	const refs = readUrlsFile(path);
	console.log(`[dump] file モード: ${refs.length} 件`);
	return refs;
}

/**
 * auto モードで購入済み一覧を取得し、_index.json に保存する
 */
async function refsFromPurchases(
	client: NoteClient,
	outDir: string,
): Promise<NoteRef[]> {
	console.log("[dump] auto モード: 購入済み一覧を取得中…");
	const refs = await client.fetchPurchasedKeys();
	console.log(`[dump] 取得: ${refs.length} 件`);
	const indexPath = join(outDir, "_index.json");
	await writeFile(indexPath, JSON.stringify(refs, null, 2), "utf8");
	return refs;
}

/**
 * mode に応じてダンプ対象の NoteRef を集める
 */
async function resolveRefs(
	cfg: Config,
	client: NoteClient,
): Promise<NoteRef[]> {
	if (cfg.mode === "args") return refsFromArgs(cfg.positional);
	if (cfg.mode === "file") return refsFromUrlsFile(cfg.urlsFile);
	return await refsFromPurchases(client, cfg.outDir);
}

/**
 * 対象を並行ダンプし、進捗を表示する
 */
async function dumpAll(
	client: NoteClient,
	refs: NoteRef[],
	cfg: Config,
): Promise<void> {
	let done = 0;
	await runWithConcurrency(refs, cfg.concurrency, async (ref) => {
		done++;
		console.log(`[${done}/${refs.length}] ${ref.key} ${ref.title ?? ""}`);
		await dumpOne(client, ref, cfg);
	});
}

/**
 * CLI エントリポイント
 * 設定読み込み、対象列挙、並行ダンプの順に実行する
 *
 * @param argv - CLI 引数 (process.argv.slice(2) 相当)
 */
export async function runDump(argv: string[]): Promise<void> {
	const cfg = loadConfig(argv);
	const client = new NoteClient(cfg.cookie, cfg.requestDelayMs);
	await mkdir(cfg.outDir, { recursive: true });

	const refs = await resolveRefs(cfg, client);
	const targets = cfg.limit !== undefined ? refs.slice(0, cfg.limit) : refs;

	if (targets.length === 0) {
		console.log(
			"[dump] 対象0件。auto で取れない場合は --mode=file --urls=urls.txt を試してください。",
		);
		return;
	}

	await dumpAll(client, targets, cfg);

	console.log(`[dump] 完了。出力先: ${cfg.outDir}`);
}

if (import.meta.main) {
	runDump(process.argv.slice(2)).catch((e: Error) => {
		console.error(e.stack ?? e.message);
		process.exit(1);
	});
}
