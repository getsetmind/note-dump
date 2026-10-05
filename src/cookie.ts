import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Cookie ヘッダまたは値だけを検証し、.env と実行中の設定を更新する
 *
 * @param input - DevTools からコピーした Cookie ヘッダ
 * @param envPath - 更新する .env ファイル
 */
export function saveCookie(input: string, envPath: string): void {
	const cookie = input.trim().replace(/^cookie:\s*/i, "");
	if (
		/[\r\n"']/.test(cookie) ||
		!/(?:^|;\s*)_note_session_v5=[^;\s]+/.test(cookie)
	) {
		throw new Error(
			"[cookie] _note_session_v5 を含む Cookie ヘッダを1行で貼り付けてください。",
		);
	}
	const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
	const lines = text
		.split(/\r?\n/)
		.filter((line) => !/^\s*(?:export\s+)?NOTE_COOKIE\s*=/.test(line));
	while (lines.at(-1) === "") lines.pop();
	lines.push(`NOTE_COOKIE="${cookie}"`, "");
	writeFileSync(envPath, lines.join("\n"), "utf8");
	process.env.NOTE_COOKIE = cookie;
}
