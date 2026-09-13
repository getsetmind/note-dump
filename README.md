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

#### A. CDP 自動取得 (推奨)

Chrome を `--remote-debugging-port=9222` 付きで起動済みで note.com にログインしている前提:

```bash
bun run cookie:cdp
```

`_note_session_v5` (httpOnly) も含めて全 Cookie を取得し、`.env` の `NOTE_COOKIE` を自動で書き換える

#### B. 手動コピー (フォールバック)

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

複数の非公式エンドポイントを順に試し、ダメならライブラリページの HTML を解析する
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
| `--format`      | `md`        | `md` / `html` / `both` `html`/`both` は CDP で実ブラウザから `page.html` を取得 |
| `--youtube-dl`  | off         | 本文の YouTube 埋め込みを `yt-dlp` で `videos/` に保存 (要 PATH) |
| `--cdp-url`     | `http://localhost:9222` | CDP エンドポイント (`--format=html`/`both` 時に使用) |

`dump:html` / `dump:both` は `--format` を指定済みのショートカット:

```bash
bun run dump:html      # HTML スナップショットのみ
bun run dump:both      # Markdown + HTML 両方
```

`--format=html` / `both` は CDP 経由で実ブラウザに記事を開かせ、ヘッダ等のログイン UI を除去・lazy-load 発火後に DOM をダンプする `bun run cookie:cdp` と同じく `localhost:9222` の CDP が必要 `<img>` はローカル DL して相対参照に書き換えるが、CSS は note.com を絶対参照で残すためオフラインだとレイアウトが崩れる

## 出力構造

```text
out/
├─ _index.json                       # auto モード時の取得一覧
└─ <noteKey>_<title>/
   ├─ index.md                       # frontmatter + 本文 Markdown (--format=md/both 時)
   ├─ page.html                      # ブラウザ DOM スナップショット (--format=html/both 時)
   ├─ meta.json                      # API レスポンス生データ (常に出力)
   ├─ images/                        # md/html いずれかが有効なとき
   │  ├─ <hash>.png
   │  └─ ...
   └─ videos/                        # --youtube-dl 指定時のみ
      └─ <id>.<ext>
```
