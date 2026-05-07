# note-dump

note.com の購入済み有料記事を Markdown + 画像でローカルにダンプする CLI。

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

Comet/Chrome を `--remote-debugging-port=9222` 付きで起動済みで note.com にログインしている前提:

```bash
bun run cookie:cdp
```

`_note_session_v5` (httpOnly) も含めて全 Cookie を取得し、`.env` の `NOTE_COOKIE` を自動で書き換える。

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
```

複数の非公式エンドポイントを順に試し、ダメならライブラリページの HTML を解析する。
取得した一覧は `out/_index.json` に保存される。

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
| `--mode`        | `auto`      | `auto` または `file`            |
| `--out`         | `./out`     | 出力ディレクトリ                |
| `--urls`        | `./urls.txt`| file モードで読み込む URL リスト |
| `--concurrency` | `2`         | 同時並行数                      |
| `--delay`       | `600`       | リクエスト間隔 (ms)             |
| `--limit`       | (なし)      | 先頭 N 件のみ処理 (動作確認用)   |

## 出力構造

```
out/
├─ _index.json                       # auto モード時の取得一覧
└─ <noteKey>_<title>/
   ├─ index.md                       # frontmatter + 本文 Markdown
   ├─ meta.json                      # API レスポンス生データ
   └─ images/
      ├─ <hash>.png
      └─ ...
```

## 注意

- note.com の API は非公式・無保証。エンドポイントが消える可能性あり
- 過度な並行・短い delay はレートリミットや BAN を招くため避ける
- ダンプしたコンテンツは個人利用に留め、再配布しない
