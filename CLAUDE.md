# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

note.com の購入済み有料記事を Markdown + 画像でローカルにダンプする Bun 製 CLI。
note.com の **非公式** API + ログイン Cookie を使うため、エンドポイントが消える前提で複数候補を順に試すフォールバック戦略を取る。

## コマンド

ランタイムは Bun (1.3+)。`npm`/`node` ではなく `bun` を使う。

```bash
bun install
bun run dump:auto              # 購入済みを API/HTML から自動取得して全件ダンプ
bun run dump:file --urls=urls.txt  # URL リストから手動ダンプ
bun run typecheck              # tsc --noEmit
bun run lint                   # biome lint .
bun run format                 # biome check --write --unsafe .
```

CLI フラグ (`src/dump.ts` 経由): `--mode={auto|file}` `--out=` `--urls=` `--concurrency=` `--delay=` `--limit=`。
動作確認は `--limit=1` を付けて 1 件だけ流すと早い。

## 必須セットアップ

`.env` の `NOTE_COOKIE` がないと `loadConfig` が即 throw する。Cookie 取得は `scripts/get-cookie.js` をブラウザ DevTools コンソールで実行 → `_note_session_v5` (httpOnly のため JS から取れない) を Application タブから手動で末尾追記。詳細は README 参照。

## アーキテクチャ

エントリポイント `src/dump.ts` から 3 モジュール構成。

- **`src/config.ts`** — `.env` 自前パース (dotenv 依存なし) + `--key=value` 形式の argv パース。CLI 引数が `process.env` より優先。
- **`src/api.ts`** — `NoteClient` クラス。Cookie/UA/Referer 付き fetch + `lastAt` ベースの直列スロットリング (`throttle()`)。重要: `fetchPurchasedKeys()` は API v1/v2/v3 を順に試し、すべて失敗したら `library/purchased` 等の HTML を `node-html-parser` で解析するフォールバックチェーン。エンドポイント追加はこの配列に足すだけ。
- **`src/markdown.ts`** — `downloadImagesAndRewrite()` で本文 HTML 内の `<img>` を全部ローカル DL し `src` を `images/<sha1先頭10>.<ext>` に書き換え → `htmlToMarkdown()` で turndown 変換。`iframe`/`embed` は `[embed](url)` に、`figure` は改行で囲むカスタムルール。

### 出力レイアウト

`out/<noteKey>_<sanitized-title>/` 配下に `index.md` (frontmatter + 本文)、`meta.json` (API 生レス)、`images/`。auto モード時は `out/_index.json` に取得一覧を保存。

### 並行制御

`runWithConcurrency()` はワーカープール方式 (`Promise.all` で N 個のループ)。失敗は warn してスキップする (継続性優先)。`concurrency` を上げすぎると BAN リスクがあるため既定 2、`requestDelayMs` 既定 600ms は維持推奨。

## コードスタイル

- 共有 Biome/TS 設定 (`@yuu1111/biome-config`, `@yuu1111/tsconfig`) を継承。`biome.json` / `tsconfig.json` で上書き要件があれば extends 後に追記する。
- TypeScript は strict 前提。`exactOptionalPropertyTypes` 由来の `string | undefined` を許容するため、optional プロパティは `| undefined` を明示している (`NoteRef.title` 等)。プロパティ省略形 (`?:` のみ) は使わない。
- ログ・エラーメッセージは日本語。プレフィックス `[dump]` `[api]` `[img]` で出処を示す慣習。
