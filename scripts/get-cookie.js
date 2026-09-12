// note.com にログインした状態で、DevTools (F12) のコンソールに貼り付けて実行する
//
// 重要: _note_session_v5 / XSRF-TOKEN は httpOnly のため JavaScript からは
// 取得できず、このスクリプトは
//   1. document.cookie で取れる分を表示・クリップボードにコピー
//   2. httpOnly 分を Application タブから手動で取得する手順を表示
//   3. 最終的に .env に貼る形のテンプレートを生成
// する
(async () => {
	const visible = document.cookie;
	const required = ["_note_session_v5", "XSRF-TOKEN"];
	const missing = required.filter((n) => !visible.includes(`${n}=`));

	const bold = "color:#0bf;font-weight:bold";
	const ok = "color:#3c3;font-weight:bold";
	const warn = "color:#f80;font-weight:bold";

	console.log("%c[note-dump] document.cookie で取得できた Cookie:", bold);
	console.log(visible || "(なし)");

	const template =
		`NOTE_COOKIE="${visible}` +
		missing.map((n) => `; ${n}=<ここに手動で貼る>`).join("") +
		'"';

	if (missing.length > 0) {
		console.log("%c[note-dump] 手動取得が必要な Cookie:", warn);
		console.log(missing.join(", "));
		console.log("%c[note-dump] 取得手順:", warn);
		console.log(
			[
				"  1. DevTools の [Application] タブを開く",
				"  2. 左サイドバー [Storage] → [Cookies] → https://note.com を選択",
				"  3. Name 列が " + missing.join(" と ") + " の行を探す",
				"  4. Value 列の値をダブルクリック → 全選択 → コピー",
				"  5. 下のテンプレートの <ここに手動で貼る> を置換して .env に保存",
			].join("\n"),
		);
	}

	console.log("%c[note-dump] .env 用テンプレート:", bold);
	console.log(template);

	// クリップボードコピー (focus 問題回避のため execCommand フォールバック)
	const tryClipboard = async () => {
		try {
			await navigator.clipboard.writeText(template);
			return true;
		} catch (_) {
			// fallthrough
		}
		const ta = document.createElement("textarea");
		ta.value = template;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const success = document.execCommand("copy");
		document.body.removeChild(ta);
		return success;
	};

	if (await tryClipboard()) {
		console.log(
			"%c[note-dump] テンプレートをクリップボードにコピーしました。",
			ok,
		);
	} else {
		console.log(
			"%c[note-dump] 自動コピー失敗。上のテンプレートを手動でコピーしてください。",
			warn,
		);
	}
})();
