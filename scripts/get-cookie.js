// note.com にログインした状態で、DevTools (F12) のコンソールに貼り付けて実行する。
// document.cookie から取得できる Cookie をクリップボードにコピーする。
//
// 注意:
//  _note_session_v5 など httpOnly Cookie は JavaScript からは取得できない。
//  実行後にコンソールへ表示される結果を見て _note_session_v5 が含まれて
//  いなければ、DevTools の Application タブ → Cookies → https://note.com から
//  _note_session_v5 の Value を手動コピーし、末尾に
//    ; _note_session_v5=<value>
//  を追記して .env の NOTE_COOKIE に貼り付ける。
(async () => {
	const cookie = document.cookie;
	const required = ["_note_session_v5", "XSRF-TOKEN"];
	const missing = required.filter((n) => !cookie.includes(`${n}=`));

	console.log("%c[note-dump] document.cookie:", "color:#0bf;font-weight:bold");
	console.log(cookie);

	if (missing.length > 0) {
		console.warn(
			`[note-dump] httpOnly のため取得できなかった Cookie: ${missing.join(", ")}`,
		);
		console.warn(
			"[note-dump] DevTools の Application → Cookies → https://note.com から手動で追記してください。",
		);
	}

	try {
		await navigator.clipboard.writeText(cookie);
		console.log("%c[note-dump] クリップボードにコピーしました。", "color:#3c3");
	} catch (e) {
		console.warn("[note-dump] クリップボードコピー失敗。手動でコピーしてください。", e);
	}
})();
