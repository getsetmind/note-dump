# プロジェクト概要

note.com の購入済み有料記事を Markdown + 画像でローカルにダンプする Bun 製 CLI
note.com の 非公式API + ログイン Cookie を使うため、エンドポイントが消える前提で複数候補を順に試すフォールバック戦略を取る

# コマンド

ランタイムは Bun (1.3+)、`npm`/`node` ではなく `bun` を使う

```bash
bun install
bun run dump:auto              # 購入済みを API/HTML から自動取得して全件ダンプ
bun run dump:file --urls=urls.txt  # URL リストから手動ダンプ
bun run typecheck              # tsc --noEmit
bun run lint                   # biome lint .
bun run format                 # biome check --write --unsafe .
bun run check:quality          # 統合品質検査 (biome/typecheck/knip/comment/document-style/tsdoc)
```

CLI フラグ (`src/dump.ts` 経由): `--mode={auto|file|args}` `--out=` `--urls=` `--concurrency=` `--delay=` `--limit=` `--format={md|html|both}` `--html-source={http|cdp}` `--youtube-dl` `--cdp-url=` `args` モードは positional 引数 (URL or note key) を直接渡す形で、`--mode` 省略時に positional があれば自動選択される
動作確認は `--limit=1` を付けて 1 件だけ流すと早い

`--format=html` (or `both`) は既定で Cookie 付き HTTP により元ページを取得し、元の本文コンテナへ API の購入済み本文を差し込む CSS・フォント・背景画像は `assets/`、本文画像は `images/` に保存し、スクリプト・ヘッダ・購入案内を除去する CDP 不要 元のブラウザ DOM 取得は `--html-source=cdp` で明示した場合のみ使用し、`localhost:9222` への接続が必要 (`--cdp-url=` で変更可) `--youtube-dl` は本文の YouTube 埋め込みを `yt-dlp` で `videos/` に DL する (未インストール時は warn してスキップ) 既定オフ

# 必須セットアップ

`.env` の `NOTE_COOKIE` がないと `loadConfig` が即 throw する 推奨の登録方法は通常ブラウザの DevTools → Network → Request Headers から Cookie の値全体をコピーし、`bun run menu` の Cookie 登録へ貼り付ける方法 (httpOnly も含む) `src/cookie.ts` が既存設定を保持して保存し、実行中の環境変数も更新する 従来の `scripts/get-cookie.js` と `bun run cookie:cdp` も利用可能 詳細は README 参照

# アーキテクチャ

エントリポイント `src/dump.ts` と対話メニュー `src/interactive.ts` から各モジュールを呼び出す

- **`src/config.ts`** — `.env` 自前パース (dotenv 依存なし) + `--key=value` 形式の argv パース CLI 引数が `process.env` より優先
- **`src/api.ts`** — `NoteClient` クラス Cookie/UA/Referer 付き fetch + `lastAt` ベースの直列スロットリング (`throttle()`) `fetchPurchasedKeys()` は `api/v3/payments/purchase_notes` を `page=1..200` でページング取得し、空ページで打ち切る エンドポイントが消えた場合はこの URL を差し替えるか、複数候補を順に試すフォールバック実装に書き換える
- **`src/markdown.ts`** — `downloadImagesAndRewrite()` で本文 HTML を `node-html-parser` でパースし `<img>` を全部ローカル DL、`src` を `images/<sha1先頭10>.<ext>` に書き換え → `htmlToMarkdown()` で turndown 変換 `iframe`/`embed` は `[embed](url)` に、`figure` は改行で囲むカスタムルール
- **`src/snapshot.ts`** — CDP (browser-level WS) に接続し `Target.createTarget` → `Page.navigate` → `Runtime.evaluate` で `<header>` 除去 + 末尾スクロール (lazy-load 発火) + `document.documentElement.outerHTML` を返す 複数 RPC 兼イベント待ちのために `CdpSession` クラス自前実装 (get-cookie-cdp.ts の単発 RPC とは別) MHTML は試行したが `<img src>` が data:placeholder のまま埋め込まれて表示できないため不採用、`page.html` + 別 `images/` 参照に倒した
- **`src/http-snapshot.ts`** — 既定の HTML 保存 元ページの SSR HTML へ API 本文を差し込み、展開済み埋め込みを引き継ぐ 新旧の本文セレクタを順に試す CSS の import と url() を再帰保存し、循環参照はキャッシュで止める 本文不明・空本文は失敗、アセット取得失敗は warn して絶対 URL を残す
- **`src/cookie.ts`** — 貼り付けた Cookie ヘッダを検証し、`.env` の NOTE_COOKIE だけを更新する
- **`src/youtube.ts`** — 本文 HTML の `iframe`/`embed`/`a` から YouTube URL 抽出 (`/embed/<id>` を `watch?v=<id>` に正規化) し、`yt-dlp` (PATH 必須) を子プロセスで起動して `videos/<id>.<ext>` に保存

## 出力レイアウト

`out/<noteKey>_<sanitized-title>/` 配下に `index.md` (frontmatter + 本文 / `--format` が md か both のとき)、`meta.json` (API 生レス、常に出力)、`images/` (md / html いずれかの時)、`page.html` (`--format` が html か both のとき)、`videos/` (`--youtube-dl` 指定時) auto モード時は `out/_index.json` に取得一覧を保存

HTTP HTML 保存時は `assets/` に CSS・フォント・背景画像も保存する 回帰テストは `bun run test` で実行する

## 並行制御

`runWithConcurrency()` はワーカープール方式 (`Promise.all` で N 個のループ) 失敗は warn してスキップする (継続性優先) `concurrency` を上げすぎると BAN リスクがあるため既定 2、`requestDelayMs` 既定 600ms は維持推奨

# コードスタイル

- 共有 Biome/TS 設定 (`@yuu1111/biome-config`, `@yuu1111/tsconfig`) を継承 `biome.json` / `tsconfig.json` で上書き要件があれば extends 後に追記する
- TypeScript は strict 前提 `exactOptionalPropertyTypes` 由来の `string | undefined` を許容するため、optional プロパティは `| undefined` を明示している (`NoteRef.title` 等) プロパティ省略形 (`?:` のみ) は使わない
- ログ・エラーメッセージは日本語 プレフィックス `[dump]` `[api]` `[img]` で出処を示す慣習
