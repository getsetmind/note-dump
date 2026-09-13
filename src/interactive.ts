import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { loadDotenv } from "./config";
import { runDump } from "./dump";
import type { Format } from "./schemas";

/**
 * ダンプ系メニューで共通に聞く出力オプション
 */
interface DumpOptions {
	format: Format;
	youtubeDl: boolean;
	concurrency: number;
	limit: number | undefined;
}

/**
 * トップメニューの 1 項目
 */
interface MenuItem {
	value: string;
	label: string;
	run: () => Promise<void> | void;
}

/**
 * Ctrl+C を検知したら outro を表示して exit する
 * symbol を型レベルで除去するため、呼び出し側で as キャストは不要
 */
function unwrapCancelled<T>(value: T | typeof p.CANCEL_SYMBOL): T {
	if (p.isCancel(value)) {
		p.cancel("中断しました");
		process.exit(0);
	}
	return value;
}

/**
 * プロンプトの結果を待ち、キャンセルされていれば終了する
 */
function ask<T>(prompt: Promise<T | typeof p.CANCEL_SYMBOL>): Promise<T> {
	return prompt.then(unwrapCancelled);
}

/**
 * 1 以上の整数として解釈できる値を返す
 * 解釈できない場合は undefined
 */
function parsePositiveInt(value: string | undefined): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/**
 * format/youtube-dl/concurrency/limit を順に聞く
 */
async function askDumpOptions(): Promise<DumpOptions> {
	const format = await ask(
		p.select<Format>({
			message: "出力フォーマット",
			options: [
				{ value: "md", label: "Markdown のみ", hint: "既定" },
				{ value: "html", label: "HTML のみ (CDP 必要)" },
				{ value: "both", label: "両方" },
			],
			initialValue: "md",
		}),
	);

	const youtubeDl = await ask(
		p.confirm({
			message: "YouTube 埋め込みを yt-dlp でローカル保存する?",
			initialValue: false,
		}),
	);

	const concurrency = await ask(
		p.text({
			message: "並行数",
			initialValue: "2",
			validate: (v) =>
				parsePositiveInt(v) === undefined
					? "1 以上の整数を入れてください"
					: undefined,
		}),
	);

	const limit = await ask(
		p.text({
			message: "件数上限 (空欄で無制限)",
			placeholder: "例: 5",
			validate: (v) =>
				v === "" || parsePositiveInt(v) !== undefined
					? undefined
					: "1 以上の整数 or 空欄",
		}),
	);

	return {
		format,
		youtubeDl,
		concurrency: Number(concurrency),
		limit: limit === "" ? undefined : Number(limit),
	};
}

/**
 * DumpOptions を loadConfig が読む argv 形式に変換する
 */
function optionsToArgv(opts: DumpOptions): string[] {
	const argv: string[] = [
		`--format=${opts.format}`,
		`--concurrency=${opts.concurrency}`,
	];
	if (opts.youtubeDl) argv.push("--youtube-dl");
	if (opts.limit !== undefined) argv.push(`--limit=${opts.limit}`);
	return argv;
}

/**
 * 入力テキストを区切って URL/key の配列にする
 * note key 形式や note URL を緩く受け付け、解釈不能なトークンは warn 表示してスキップする
 */
function splitInputs(text: string): string[] {
	return text
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter((t) => t !== "");
}

/**
 * ダンプ系 3 フローの末尾共通処理 (オプション質問 → 確認 → 実行)
 * modeArgv に各モード固有のフラグや positional 引数を渡す
 */
async function confirmAndRun(
	confirmMessage: string,
	modeArgv: string[],
): Promise<void> {
	const opts = await askDumpOptions();
	const ok = await ask(
		p.confirm({ message: confirmMessage, initialValue: true }),
	);
	if (!ok) return;
	await runDump([...modeArgv, ...optionsToArgv(opts)]);
}

/**
 * 購入済み API から全件取得してダンプする
 */
async function flowAuto(): Promise<void> {
	await confirmAndRun("購入済みを全件取得して dump する?", ["--mode=auto"]);
}

/**
 * 入力欄に貼り付けた URL/key を positional として dump.ts に流す
 */
async function flowArgs(): Promise<void> {
	const rawInput = await ask(
		p.text({
			message: "URL or note key を入力 (空白/カンマ/改行で区切り)",
			placeholder: "https://note.com/<user>/n/<key>  または  n123abc",
			validate: (v) => (v?.trim() ? undefined : "1 つ以上指定してください"),
		}),
	);
	const inputs = splitInputs(rawInput);
	if (inputs.length === 0) {
		p.log.error("有効な入力が 0 件でした");
		return;
	}
	p.log.info(`${inputs.length} 件を対象にします`);
	await confirmAndRun("実行する?", inputs);
}

/**
 * URL リストファイルを指定してダンプする
 * ファイルの存在チェックは dump.ts 側 (readUrlsFile) に任せる
 */
async function flowFile(): Promise<void> {
	const path = await ask(
		p.text({
			message: "URL リストファイルのパス",
			initialValue: "./urls.txt",
		}),
	);
	await confirmAndRun(`${path} を読み込んで dump する?`, [
		"--mode=file",
		`--urls=${path}`,
	]);
}

/**
 * scripts/get-cookie-cdp.ts を子プロセスで実行して Cookie を更新する (stdio inherit)
 * 完了後 process.env.NOTE_COOKIE は更新されないため、利用には対話 CLI の再起動が必要
 */
async function flowCookie(): Promise<void> {
	const ok = await ask(
		p.confirm({
			message:
				"localhost:9222 で起動中の Chrome (--remote-debugging-port) から Cookie を取得します。続行する?",
			initialValue: true,
		}),
	);
	if (!ok) return;

	const s = p.spinner();
	s.start("Cookie を取得中…");
	const proc = Bun.spawn(["bun", "run", "scripts/get-cookie-cdp.ts"], {
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code === 0) {
		s.stop("完了 (再起動すると新しい Cookie が読まれます)");
	} else {
		s.stop(`失敗 (exit ${code})`);
	}
}

/**
 * 現在の設定を表示する
 * Cookie の有効性は疎通確認せず、長さと _note_session_v5 の有無だけで判定する
 */
function flowSettings(): void {
	const cookie = process.env.NOTE_COOKIE ?? "";
	const hasSession = cookie.includes("_note_session_v5");
	const lines = [
		`NOTE_COOKIE:    ${cookie ? `${cookie.length} 文字` : "未設定"}`,
		`_note_session:  ${hasSession ? "あり" : "なし"}`,
		`OUT_DIR:        ${process.env.OUT_DIR ?? "(既定: ./out)"}`,
		`CDP_URL:        ${process.env.CDP_URL ?? "(既定: http://localhost:9222)"}`,
		`CONCURRENCY:    ${process.env.CONCURRENCY ?? "(既定: 2)"}`,
	];
	p.note(lines.join("\n"), "現在の設定");
	if (!cookie) {
		p.log.warn("NOTE_COOKIE が空です。Cookie 更新メニューから取得してください");
	} else if (!hasSession) {
		p.log.warn(
			"_note_session_v5 が含まれていません。購入記事の取得に失敗する可能性があります",
		);
	}
}

/**
 * 何もしないハンドラ (exit は step() の戻り値側でループを抜ける)
 */
function noop(): void {
	// exit の判定は step() の戻り値側で行う
}

/**
 * トップメニューの選択肢
 * ラベルと実行するフローを 1 箇所にまとめて持つ
 */
const MENU = [
	{ value: "auto", label: "全件ダンプ (購入済みを自動取得)", run: flowAuto },
	{ value: "args", label: "URL / note key を指定してダンプ", run: flowArgs },
	{ value: "file", label: "urls.txt から読み込みダンプ", run: flowFile },
	{ value: "cookie", label: "Cookie を更新 (CDP 経由)", run: flowCookie },
	{ value: "settings", label: "設定を確認", run: flowSettings },
	{ value: "exit", label: "終了", run: noop },
] as const satisfies readonly MenuItem[];

/**
 * トップメニューの選択値
 */
type MenuChoice = (typeof MENU)[number]["value"];

/**
 * トップメニュー 1 ターンぶんを処理する
 * "exit" を返したらループを終了する
 */
async function step(): Promise<MenuChoice> {
	const choice = await ask(
		p.select<MenuChoice>({
			message: "メニュー",
			options: MENU.map(({ value, label }) => ({ value, label })),
		}),
	);
	try {
		const item = MENU.find((entry) => entry.value === choice);
		if (item) await item.run();
	} catch (e) {
		p.log.error((e as Error).message);
	}
	return choice;
}

/**
 * 起動時に .env を一度だけ process.env に展開してメニューループへ入る
 */
async function main(): Promise<void> {
	loadDotenv(resolve(process.cwd(), ".env"));
	p.intro("note-dump 対話メニュー");
	while (true) {
		const c = await step();
		if (c === "exit") break;
	}
	p.outro("また使ってください");
}

if (import.meta.main) {
	main().catch((e: Error) => {
		console.error(e.stack ?? e.message);
		process.exit(1);
	});
}
