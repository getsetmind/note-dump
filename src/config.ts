import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Mode = "auto" | "file";

export interface Config {
	cookie: string;
	outDir: string;
	concurrency: number;
	requestDelayMs: number;
	mode: Mode;
	urlsFile: string;
	limit: number | undefined;
}

function loadDotenv(path: string): void {
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

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const a of argv) {
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		if (eq < 0) {
			out[a.slice(2)] = "true";
		} else {
			out[a.slice(2, eq)] = a.slice(eq + 1);
		}
	}
	return out;
}

export function loadConfig(argv: string[]): Config {
	loadDotenv(resolve(process.cwd(), ".env"));
	const args = parseArgs(argv);

	const cookie = process.env.NOTE_COOKIE ?? "";
	if (cookie === "") {
		throw new Error(
			"NOTE_COOKIE が未設定。.env を作成して note.com の Cookie を設定してください。",
		);
	}

	const outDir = resolve(args.out ?? process.env.OUT_DIR ?? "./out");
	const concurrency = Number(args.concurrency ?? process.env.CONCURRENCY ?? 2);
	const requestDelayMs = Number(
		args.delay ?? process.env.REQUEST_DELAY_MS ?? 600,
	);
	const mode = (args.mode ?? "auto") as Mode;
	if (mode !== "auto" && mode !== "file") {
		throw new Error(`不明なモード: ${mode}`);
	}
	const urlsFile = resolve(args.urls ?? "./urls.txt");
	const limit = args.limit !== undefined ? Number(args.limit) : undefined;

	return {
		cookie,
		outDir,
		concurrency,
		requestDelayMs,
		mode,
		urlsFile,
		limit,
	};
}
