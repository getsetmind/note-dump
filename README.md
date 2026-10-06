# note-dump

note.com の記事を Markdown / HTML スナップショット + 画像 + (任意で YouTube 動画) としてローカルにダンプする CLI

## 必要環境

- [Bun](https://bun.sh) 1.3+
- note.com にログイン済みのブラウザ

## セットアップ

```bash
bun install
cp .env.example .env
```

### Cookie の取得

#### A. Cookie ヘッダを貼り付け (推奨、CDP 不要)

1. 通常起動のブラウザで note.com にログインする
2. F12 → **Network** を開き、ページを再読み込みする
3. note.com 宛てのリクエストを選び、**Request Headers → Cookie** の値全体をコピーする
4. `bun run menu` → **Cookie を登録・更新** → **Cookie ヘッダを貼り付け** を選び、コピーした値を貼る

httpOnly の `_note_session_v5` もリクエストヘッダからまとめてコピーできる 入力は伏せ字で表示し、既存の `.env` の他の設定を保持して保存する メニューを再起動せず、そのままダンプできる

直接 `.env` の `NOTE_COOKIE="..."` に貼り付けてもよい

#### B. CDP 自動取得 (任意)

Chrome を `--remote-debugging-port=9222` 付きで起動済みで note.com にログインしている前提:

```bash
bun run cookie:cdp
```

`_note_session_v5` (httpOnly) も含めて全 Cookie を取得し、`.env` の `NOTE_COOKIE` を自動で書き換える

#### C. 従来の手動コピー

CDP が使えないとき:

1. ブラウザで <https://note.com> にログインする
2. F12 で DevTools を開き、コンソールに `scripts/get-cookie.js` の中身を貼り付けて実行
3. クリップボードに `.env` テンプレートがコピーされる
4. `_note_session_v5` / `XSRF-TOKEN` (httpOnly) は JS から取れないので、
   DevTools の **Application → Cookies → `https://note.com`** から手動で Value をコピーし、
   テンプレートの `<ここに手動で貼る>` を置き換える
5. `.env` に保存

## 使い方

### auto モード (推奨、購入済み一覧を自動取得)

```bash
bun run dump:auto
# HTML スナップショットも欲しい場合
bun run dump:auto -- --format=both
```

非公式の購入済み API から一覧を取得する
取得した一覧は `out/_index.json` に保存される

### args モード (URL を直接渡す)

URL/key を引数として直接渡すと、その記事のみダンプする `--mode` 省略時、位置引数があれば自動で `args` モードになる

```bash
bun run dump https://note.com/<creator>/n/<noteKey>
bun run dump <noteKey1> <noteKey2>
```

### file モード (URL を手動で渡す)

`urls.txt` を用意して 1 行 1 URL/key で書き、

```bash
bun run dump:file --urls=urls.txt
```

許容形式:

- `https://note.com/<creator>/n/<noteKey>`
- `https://note.com/n/<noteKey>`
- `<noteKey>` のみ

### オプション

| フラグ          | 既定        | 説明                            |
| --------------- | ----------- | ------------------------------- |
| `--mode`        | `auto`      | `auto` / `file` / `args`        |
| `--out`         | `./out`     | 出力ディレクトリ                |
| `--urls`        | `./urls.txt`| file モードで読み込む URL リスト |
| `--concurrency` | `2`         | 同時並行数                      |
| `--delay`       | `600`       | リクエスト間隔 (ms)             |
| `--limit`       | (なし)      | 先頭 N 件のみ処理 (動作確認用)   |
| `--format`      | `md`        | `md` / `html` / `both` HTML は元ページのレイアウトと CSS を保存 (CDP 不要) |
| `--html-source` | `http`      | `http` / `cdp` 通常は直接取得、必要に応じて従来のブラウザ DOM 取得を選べる |
| `--youtube-dl`  | off         | 本文の YouTube 埋め込みを `yt-dlp` で `videos/` に保存 (要 PATH) |
| `--cdp-url`     | `http://localhost:9222` | `--html-source=cdp` 時の接続先 |

`dump:html` / `dump:both` は `--format` を指定済みのショートカット:

```bash
bun run dump:html      # HTML スナップショットのみ
bun run dump:both      # Markdown + HTML 両方
```

`--format=html` / `both` は Cookie 付き HTTP で元ページを取得し、元の本文コンテナに API の購入済み本文を組み込む 元のクラス名・レイアウト・インライン CSS を保持し、画像は `images/`、外部 CSS と参照先のフォント・背景画像は `assets/` に保存する ヘッダ・購入案内・サイトのスクリプトは除去し、遅延読み込み属性を通常の参照へ書き換える

本文コンテナが見つからない場合や API 本文が空の場合は、警告を出して HTML 保存を失敗扱いにする CSS 等の取得に失敗した参照は警告を出してオンライン URL を残す

元ページと内容が一致する本文ブロックは、画像の囲み・段落・見出しの表示用 HTML を引き継ぐ 目次には購入済み本文の全見出しを追加する ストリーミング SSR の後送 HTML も組み込み、本文外の空スケルトンや読み込み表示を除去する

JavaScript による動的 UI、外部サービスの埋め込み、ログイン中の画面との完全な一致は保証しない SSR で展開済みの埋め込みは引き継ぎ、未展開の埋め込みは元 URL へのリンクで残す 外部 iframe の表示にはネット接続が必要

従来のブラウザ DOM 保存を使う場合は、明示的に選ぶ:

```bash
bun run dump:both --html-source=cdp --cdp-url=http://localhost:9222
```

この場合のみ CDP 対応ブラウザが必要 HTTP 取得失敗時に CDP へ自動接続することはない 環境変数 `HTML_SOURCE` でも取得方法を指定できる

## 出力構造

```text
out/
├─ _index.json                       # auto モード時の取得一覧
└─ <noteKey>_<title>/
   ├─ index.md                       # frontmatter + 本文 Markdown (--format=md/both 時)
   ├─ page.html                      # 元ページのレイアウト + 購入済み本文 (--format=html/both 時)
   ├─ assets/                        # HTTP 保存時の CSS・フォント・背景画像
   ├─ meta.json                      # API レスポンス生データ (常に出力)
   ├─ images/                        # md/html いずれかが有効なとき
   │  ├─ <hash>.png
   │  └─ ...
   └─ videos/                        # --youtube-dl 指定時のみ
      └─ <id>.<ext>
```
