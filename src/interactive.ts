import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { loadDotenv } from "./config";
import { runDump } from "./dump";
import type { Format } from "./schemas";

/**
 * @description トップメニューの選択肢
 */
type MenuChoice = "auto" | "args" | "file" | "cookie" | "settings" | "exit";

/**
 * @description ダンプ系メニューで共通に聞く出力オプション
 */
interface DumpOptions {
	format: Format;
	youtubeDl: boolean;
	concurrency: number;
	limit: number | undefined;
}

/**
 * @description Ctrl+C を検知したら outro 出して exit する
 *   asserts 経由で symbol を型レベルで除去するため、呼び出し側で as キャスト不要
 */
function bailIfCancelled<T>(value: T | symbol): asserts value is T {
	if (p.isCancel(value)) {
		p.cancel("中断しました");
		process.exit(0);
	}
}

/**
 * @description format/youtube-dl/concurrency/limit を順に聞く
 */
async function askDumpOptions(): Promise<DumpOptions> {
	const format = await p.select<Format>({
		message: "出力フォーマット",
		options: [
			{ value: "md", label: "Markdown のみ", hint: "既定" },
			{ value: "html", label: "HTML のみ (CDP 必要)" },
			{ value: "both", label: "両方" },
		],
		initialValue: "md",
	});
	bailIfCancelled(format);

	const youtubeDl = await p.confirm({
		message: "YouTube 埋め込みを yt-dlp でローカル保存する?",
		initialValue: false,
	});
	bailIfCancelled(youtubeDl);

	const concurrency = await p.text({
		message: "並行数",
		initialValue: "2",
		validate: (v) => {
			const n = Number(v);
			if (!Number.isFinite(n) || n < 1) return "1 以上の整数を入れてください";
			return undefined;
		},
	});
	bailIfCancelled(concurrency);

	const limit = await p.text({
		message: "件数上限 (空欄で無制限)",
		placeholder: "例: 5",
		validate: (v) => {
			if (v === "") return undefined;
			const n = Number(v);
			if (!Number.isFinite(n) || n < 1) return "1 以上の整数 or 空欄";
			return undefined;
		},
	});
	bailIfCancelled(limit);

	return {
		format,
		youtubeDl,
		concurrency: Number(concurrency),
		limit: limit === "" ? undefined : Number(limit),
	};
}

/**
 * @description DumpOptions を loadConfig が読む argv 形式に直す
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
 * @description 入力テキストを区切って URL/key 配列にする
 *   note key 形式や note URL を緩く受け付け、解釈不能トークンは warn 表示してスキップ
 */
function splitInputs(text: string): string[] {
	return text
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter((t) => t !== "");
}

/**
 * @description ダンプ系3フローの末尾共通処理 (オプション質問 → 確認 → 実行)
 *   modeArgv に各モード固有のフラグや positional 引数を渡す
 */
async function confirmAndRun(
	confirmMessage: string,
	modeArgv: string[],
): Promise<void> {
	const opts = await askDumpOptions();
	const ok = await p.confirm({ message: confirmMessage, initialValue: true });
	bailIfCancelled(ok);
	if (!ok) return;
	await runDump([...modeArgv, ...optionsToArgv(opts)]);
}

/**
 * @description 購入済み API から全件取得してダンプ
 */
async function flowAuto(): Promise<void> {
	await confirmAndRun("購入済みを全件取得して dump する?", ["--mode=auto"]);
}

/**
 * @description 入力欄に貼り付けた URL/key を positional として dump.ts に流す
 */
async function flowArgs(): Promise<void> {
	const raw = await p.text({
		message: "URL or note key を入力 (空白/カンマ/改行で区切り)",
		placeholder: "https://note.com/<user>/n/<key>  または  n123abc",
		validate: (v) => (v?.trim() ? undefined : "1 つ以上指定してください"),
	});
	bailIfCancelled(raw);
	const inputs = splitInputs(raw);
	if (inputs.length === 0) {
		p.log.error("有効な入力が 0 件でした");
		return;
	}
	p.log.info(`${inputs.length} 件を対象にします`);
	await confirmAndRun("実行する?", inputs);
}

/**
 * @description ファイル存在チェックは dump.ts 側 (readUrlsFile) に任せる
 */
async function flowFile(): Promise<void> {
	const path = await p.text({
		message: "URL リストファイルのパス",
		initialValue: "./urls.txt",
	});
	bailIfCancelled(path);
	await confirmAndRun(`${path} を読み込んで dump する?`, [
		"--mode=file",
		`--urls=${path}`,
	]);
}

/**
 * @description scripts/get-cookie-cdp.ts を子プロセスで実行 (stdio inherit)
 *   完了後 process.env.NOTE_COOKIE は更新されないため、利用には対話 CLI 再起動が必要
 */
async function flowCookie(): Promise<void> {
	const ok = await p.confirm({
		message:
			"localhost:9222 で起動中の Chrome (--remote-debugging-port) から Cookie を取得します。続行する?",
		initialValue: true,
	});
	bailIfCancelled(ok);
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
 * @description Cookie 有効性は表示のみ (疎通確認はせず長さ + _note_session_v5 の有無で判定)
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
 * @description トップメニュー1ターンぶん。"exit" を返したらループ終了
 */
async function step(): Promise<MenuChoice> {
	const choice = await p.select<MenuChoice>({
		message: "メニュー",
		options: [
			{ value: "auto", label: "全件ダンプ (購入済みを自動取得)" },
			{ value: "args", label: "URL / note key を指定してダンプ" },
			{ value: "file", label: "urls.txt から読み込みダンプ" },
			{ value: "cookie", label: "Cookie を更新 (CDP 経由)" },
			{ value: "settings", label: "設定を確認" },
			{ value: "exit", label: "終了" },
		],
	});
	bailIfCancelled(choice);
	try {
		switch (choice) {
			case "auto":
				await flowAuto();
				break;
			case "args":
				await flowArgs();
				break;
			case "file":
				await flowFile();
				break;
			case "cookie":
				await flowCookie();
				break;
			case "settings":
				flowSettings();
				break;
			case "exit":
				break;
		}
	} catch (e) {
		p.log.error((e as Error).message);
	}
	return choice;
}

/**
 * @description 起動時に .env を一度だけ process.env に展開してメニューループへ入る
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

main().catch((e: Error) => {
	console.error(e.stack ?? e.message);
	process.exit(1);
});
