import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { z } from "zod";
import { type Config, ConfigSchema } from "./schemas";

export type { Config };

/**
 * .env を行単位でパースして process.env に流し込む
 * 既に環境変数として存在するキーは上書きしない
 */
export function loadDotenv(path: string): void {
	if (!existsSync(path)) return;
	const text = readFileSync(path, "utf8");
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
}

/**
 * --key=value / --flag 形式の argv を分解する
 */
function parseArgs(argv: string[]): {
	flags: Record<string, string>;
	positional: string[];
} {
	const flags: Record<string, string> = {};
	const positional: string[] = [];
	for (const a of argv) {
		if (!a.startsWith("--")) {
			positional.push(a);
			continue;
		}
		const eq = a.indexOf("=");
		if (eq < 0) {
			flags[a.slice(2)] = "true";
		} else {
			flags[a.slice(2, eq)] = a.slice(eq + 1);
		}
	}
	return { flags, positional };
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
 */
export function loadConfig(argv: string[]): Config {
	loadDotenv(resolve(process.cwd(), ".env"));
	const { flags, positional } = parseArgs(argv);

	const explicitMode = flags.mode;
	const inferredMode =
		explicitMode ?? (positional.length > 0 ? "args" : "auto");

	const raw = {
		cookie: process.env.NOTE_COOKIE ?? "",
		outDir: resolve(flags.out ?? process.env.OUT_DIR ?? "./out"),
		concurrency: flags.concurrency ?? process.env.CONCURRENCY ?? "2",
		requestDelayMs: flags.delay ?? process.env.REQUEST_DELAY_MS ?? "600",
		mode: inferredMode,
		urlsFile: resolve(flags.urls ?? "./urls.txt"),
		limit: flags.limit,
		positional,
		format: flags.format ?? process.env.FORMAT ?? "md",
		youtubeDl:
			flags["youtube-dl"] === "true" ||
			flags.youtubeDl === "true" ||
			process.env.YOUTUBE_DL === "true",
		cdpUrl: flags["cdp-url"] ?? process.env.CDP_URL ?? "http://localhost:9222",
	};

	const parsed = ConfigSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`設定が不正です:\n${formatZodError(parsed.error)}`);
	}
	return parsed.data;
}
