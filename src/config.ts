import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { z } from "zod";
import { type Config, ConfigSchema } from "./schemas";

/**
 * .env の 1 行から取り出した key と値
 */
interface DotenvEntry {
	key: string;
	value: string;
}

/**
 * --key=value / --flag 形式の argv を分解した結果
 */
interface ParsedArgs {
	flags: Record<string, string>;
	positional: string[];
}

/**
 * フラグも環境変数も無い場合に使う既定値
 */
const DEFAULTS = {
	outDir: "./out",
	urlsFile: "./urls.txt",
	concurrency: "2",
	requestDelayMs: "600",
	format: "md",
	cdpUrl: "http://localhost:9222",
} as const;

/**
 * .env の全行を key/value の配列へ分解する
 * 空行、'#' 始まりのコメント行、'=' を含まない行は無視する
 */
function parseDotenv(text: string): DotenvEntry[] {
	const entries: DotenvEntry[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line
			.slice(0, eq)
			.trim()
			.replace(/^export\s+/, "");
		if (key === "") continue;
		entries.push({ key, value: unquote(line.slice(eq + 1).trim()) });
	}
	return entries;
}

/**
 * 値が同じ引用符で囲まれていれば外す
 * 片側だけの引用符は値の一部として残す
 */
function unquote(value: string): string {
	const quote = value.charAt(0);
	if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * .env を行単位でパースして process.env に流し込む
 * 既に環境変数として存在するキーは上書きしない
 *
 * @param path - 読み込む .env のパス
 */
export function loadDotenv(path: string): void {
	if (!existsSync(path)) return;
	for (const { key, value } of parseDotenv(readFileSync(path, "utf8"))) {
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
}

/**
 * --key=value / --flag 形式の argv を分解する
 * 値を持たないフラグは "true" として扱う
 */
function parseArgs(argv: string[]): ParsedArgs {
	const flags: Record<string, string> = {};
	const positional: string[] = [];
	for (const arg of argv) {
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		if (eq < 0) {
			flags[arg.slice(2)] = "true";
		} else {
			flags[arg.slice(2, eq)] = arg.slice(eq + 1);
		}
	}
	return { flags, positional };
}

/**
 * CLI フラグ、環境変数、既定値の順に文字列設定を解決する
 * 別名のフラグは先に指定したものほど優先する
 */
function pickSetting(
	flags: Record<string, string>,
	flagNames: readonly string[],
	envName: string,
	fallback: string,
): string {
	for (const name of flagNames) {
		const value = flags[name];
		if (value !== undefined) return value;
	}
	return process.env[envName] ?? fallback;
}

/**
 * --mode の指定を優先し、無ければ positional の有無からモードを推測する
 * 値の妥当性は ConfigSchema が検証する
 */
function inferMode(
	explicitMode: string | undefined,
	positional: string[],
): string {
	return explicitMode ?? (positional.length > 0 ? "args" : "auto");
}

/**
 * YouTube 埋め込みのローカル保存が有効かを返す
 * --youtube-dl / --youtubeDl / YOUTUBE_DL のいずれかが "true" なら有効
 */
function resolveYoutubeDl(flags: Record<string, string>): boolean {
	return (
		flags["youtube-dl"] === "true" ||
		flags.youtubeDl === "true" ||
		process.env.YOUTUBE_DL === "true"
	);
}

/**
 * zod のエラーを CLI 向けに整形する
 */
function formatZodError(err: z.ZodError): string {
	return err.issues
		.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
		.join("\n");
}

/**
 * CLI 引数と環境変数から Config を組み立てて zod で検証する
 * フラグ、環境変数、既定値の順に優先する
 *
 * @param argv - CLI 引数 (process.argv.slice(2) 相当)
 */
export function loadConfig(argv: string[]): Config {
	loadDotenv(resolve(process.cwd(), ".env"));
	const { flags, positional } = parseArgs(argv);

	const raw = {
		cookie: process.env.NOTE_COOKIE ?? "",
		outDir: resolve(pickSetting(flags, ["out"], "OUT_DIR", DEFAULTS.outDir)),
		concurrency: pickSetting(
			flags,
			["concurrency"],
			"CONCURRENCY",
			DEFAULTS.concurrency,
		),
		requestDelayMs: pickSetting(
			flags,
			["delay"],
			"REQUEST_DELAY_MS",
			DEFAULTS.requestDelayMs,
		),
		mode: inferMode(flags.mode, positional),
		urlsFile: resolve(flags.urls ?? DEFAULTS.urlsFile),
		limit: flags.limit,
		positional,
		format: pickSetting(flags, ["format"], "FORMAT", DEFAULTS.format),
		youtubeDl: resolveYoutubeDl(flags),
		cdpUrl: pickSetting(flags, ["cdp-url"], "CDP_URL", DEFAULTS.cdpUrl),
	};

	const parsed = ConfigSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`設定が不正です:\n${formatZodError(parsed.error)}`);
	}
	return parsed.data;
}
