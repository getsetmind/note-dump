import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "node-html-parser";
import { NoteClient, type NoteDetail } from "./api";
import { saveCookie } from "./cookie";
import { captureHttpHtml } from "./http-snapshot";
import { downloadImagesAndRewrite } from "./markdown";

/**
 * ネットワークに依存せず、SSR・CSS・アセットを返す検証用サーバー
 */
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/controls")
			return new Response(`<html><body><div id="note-body"></div>
			<button id="share"><svg></svg></button><div id="empty-bar" class="fixed border-t"><button>スキ</button></div>
			<div id="fixed-link" class="fixed"><a href="/author">著者</a></div></body></html>`);
		if (path === "/decorated")
			return new Response(`<!DOCTYPE html><html><body><div id="note-body">
			<figure id="photo" class="ssr-frame"><a href="/photo.png?zoom"><img src="/photo.png?width=1200"></a><figcaption>説明</figcaption></figure>
			<nav aria-label="目次" class="original-toc"><details open><summary>目次</summary><ol><li class="original-item"><a href="#first">最初</a></li></ol><div><button>すべて表示</button></div></details></nav>
			<h2 id="first" class="original-heading">最初</h2><p id="preview">短い無料部分</p>
			</div><div data-testid="note-body-gradient-overlay" aria-hidden="true" style="background:linear-gradient(to top, white, transparent)"></div><div id="stream"><!--$?--><template id="B:0"></template><div>読み込み中<!--$?-->内側<!--/$--></div><!--/$--><p id="after">境界外</p></div>
			<div hidden id="S:0"><p id="resolved">後送された内容</p><!--$?--><template id="B:1"></template><p>入れ子の仮表示</p><!--/$--></div>
			<div hidden id="S:1"><span id="nested-resolved">入れ子の確定内容</span></div>
			<div id="empty-skeleton" class="bg-surface-quaternary">&nbsp;</div><aside><div class="animate-pulse"></div></aside>
			<script>throw new Error("実行禁止")</script></body></html>`);
		if (path === "/article")
			return new Response(`<!DOCTYPE html><html><head>
			<link rel="stylesheet" href="/main.css" integrity="old"><link rel="preload" href="/app.js">
			<meta http-equiv="Content-Security-Policy" content="block-local-files">
			<style>.inline{background:url(/inline.png)}</style></head><body>
			<header>ログイン</header><script>currentUser = "secret"</script>
			<article class="original-layout"><h1>元のタイトル</h1><div id="note-body" class="original-body">
			<p>無料部分</p><figure embedded-content-key="embed1"><iframe data-src="/embed" style="visibility:hidden"></iframe></figure>
			</div><div id="note-paywall">購入手続き</div></article></body></html>`);
		if (path === "/legacy")
			return new Response(
				'<html><body><div class="p-article__body">無料部分</div></body></html>',
			);
		if (path === "/unknown")
			return new Response("<html><body>ログイン画面</body></html>");
		if (path === "/broken")
			return new Response(
				'<html><head><link rel="stylesheet" href="/missing.css"></head><body><div id="note-body"></div></body></html>',
			);
		if (path === "/main.css")
			return new Response(
				'@import "./nested.css" screen; .body{background:url("./icon.svg#mark")} @font-face{src:url(./font.woff2)}',
				{ headers: { "content-type": "text/css" } },
			);
		if (path === "/nested.css")
			return new Response('@import url("./main.css"); .nested{color:red}', {
				headers: { "content-type": "text/css" },
			});
		if (/\.(png|svg|woff2)$/.test(path)) {
			if (request.headers.has("cookie"))
				return new Response("Cookie をアセットへ送信した", { status: 403 });
			return new Response("fixture", {
				headers: { "content-type": "image/png" },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

/**
 * API で取得済みの購入本文を表すテストデータ
 */
const detail: NoteDetail = {
	key: "n1234567890",
	name: "元のタイトル",
	body: '<p onclick="alert(1)">購入済みの全文</p><picture><source srcset="/remote.png"><img src="data:image/png;base64,AA" data-src="/photo.png" srcSet="/remote.png 2x"></picture><figure embedded-content-key="embed1"></figure><figure data-src="https://example.com/resource"></figure>',
	createdAt: undefined,
	publishAt: undefined,
	user: undefined,
	priceText: "100",
	raw: {},
};

/**
 * 各テスト専用のアセット保存先
 */
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "note-dump-test-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("元レイアウトへ購入本文を差し込み、CSS・フォント・背景画像と画像を保存する", async () => {
	const client = new NoteClient("_note_session_v5=test", 0);
	const captured = await captureHttpHtml(
		client,
		new URL("/article", server.url).href,
		detail,
		dir,
	);
	const { html } = await downloadImagesAndRewrite(
		captured,
		join(dir, "images"),
		client,
	);
	const root = parse(html);
	expect(root.querySelector("article")?.getAttribute("class")).toBe(
		"original-layout",
	);
	expect(root.querySelector("#note-body")?.getAttribute("class")).toBe(
		"original-body",
	);
	expect(root.querySelector("#note-body")?.text).toContain("購入済みの全文");
	expect(
		root.querySelector(
			"script, header, #note-paywall, meta[http-equiv], link[rel=preload]",
		),
	).toBeNull();
	expect(html).not.toContain("secret");
	expect(html).not.toContain("onclick");
	expect(html).not.toContain("srcSet");
	expect(root.querySelector("source")).toBeNull();
	expect(root.querySelector("iframe")?.getAttribute("src")).toBe(
		new URL("/embed", server.url).href,
	);
	expect(root.querySelector("iframe")?.getAttribute("style")).toContain(
		"visibility:visible",
	);
	expect(root.querySelector("figure[data-src] a")?.getAttribute("href")).toBe(
		"https://example.com/resource",
	);
	const stylesheet = root
		.querySelector('link[rel="stylesheet"]')
		?.getAttribute("href");
	expect(stylesheet).toStartWith("assets/");
	const css = await readFile(join(dir, stylesheet ?? ""), "utf8");
	expect(css).toContain("#mark");
	expect(css).not.toContain("http:");
	expect(css).not.toContain("./nested.css");
	expect(await readdir(join(dir, "assets"))).toHaveLength(5);
	expect(await readdir(join(dir, "images"))).toHaveLength(1);
	expect(root.querySelector("img")?.getAttribute("src")).toStartWith("images/");
});

test("旧ページの本文セレクタも使える", async () => {
	const html = await captureHttpHtml(
		new NoteClient("test", 0),
		new URL("/legacy", server.url).href,
		detail,
		dir,
	);
	expect(html).toContain("購入済みの全文");
});

test("SSR の装飾・目次・後送 HTML を保持し、無料プレビューで購入本文を上書きしない", async () => {
	const body =
		'<figure id="photo"><img src="/photo.png"><figcaption>説明</figcaption></figure><table-of-contents></table-of-contents><h2 id="first">最初</h2><p id="preview">購入本文の続きも全部保存する</p><h3 id="paid-heading">有料部分の見出し</h3>';
	const html = await captureHttpHtml(
		new NoteClient("test", 0),
		new URL("/decorated", server.url).href,
		{ ...detail, body },
		dir,
	);
	const root = parse(html);
	expect(root.querySelector("#photo")?.getAttribute("class")).toBe("ssr-frame");
	expect(root.querySelector("#photo a img")).not.toBeNull();
	expect(root.querySelector("#first")?.getAttribute("class")).toBe(
		"original-heading",
	);
	expect(root.querySelector("#preview")?.text).toBe(
		"購入本文の続きも全部保存する",
	);
	expect(
		root.querySelector('nav[aria-label="目次"]')?.getAttribute("class"),
	).toBe("original-toc");
	expect(root.querySelectorAll('nav[aria-label="目次"] li')).toHaveLength(2);
	expect(root.querySelector('a[href="#paid-heading"]')).not.toBeNull();
	expect(
		root.querySelector(
			"table-of-contents, button, script, template, [hidden][id]",
		),
	).toBeNull();
	expect(root.querySelector("#stream #resolved")?.text).toBe("後送された内容");
	expect(root.querySelector("#after")?.text).toBe("境界外");
	expect(root.querySelector("#stream #nested-resolved")?.text).toBe(
		"入れ子の確定内容",
	);
	expect(root.querySelector("#empty-skeleton, .animate-pulse")).toBeNull();
	expect(
		root.querySelector('[data-testid="note-body-gradient-overlay"]'),
	).toBeNull();
	expect(html).not.toContain("読み込み中");
	expect(html).not.toContain("入れ子の仮表示");
});

test("画像が差し替わった場合は同じ ID の古い SSR 画像を引き継がない", async () => {
	const body =
		'<figure id="photo"><img src="/new.png"><figcaption>説明</figcaption></figure>';
	const html = await captureHttpHtml(
		new NoteClient("test", 0),
		new URL("/decorated", server.url).href,
		{ ...detail, body },
		dir,
	);
	expect(parse(html).querySelector("#photo img")?.getAttribute("src")).toBe(
		new URL("/new.png", server.url).href,
	);
});

test("本文外の動かないボタンと空の固定バーだけを除去する", async () => {
	const html = await captureHttpHtml(
		new NoteClient("test", 0),
		new URL("/controls", server.url).href,
		{
			...detail,
			body: '<p>購入本文</p><button id="body-button">埋め込みのボタン</button><div id="body-fixed" class="fixed"></div>',
		},
		dir,
	);
	const root = parse(html);
	expect(root.querySelector("#share, #empty-bar")).toBeNull();
	expect(root.querySelector("#fixed-link a")?.text).toBe("著者");
	expect(root.querySelector("#body-button")?.text).toBe("埋め込みのボタン");
	expect(root.querySelector("#body-fixed")).not.toBeNull();
});

test("購入部分の添付ファイルのリンクと文字を維持し、表示用の構造を復元する", async () => {
	const body =
		'<figure embedded-service="attachment"><a href="https://note.com/api/v2/attachments/download/example"><strong>資料.pdf</strong> 1.12 MB\n\nダウンロード</a></figure>';
	const html = await captureHttpHtml(
		new NoteClient("test", 0),
		new URL("/legacy", server.url).href,
		{ ...detail, body },
		dir,
	);
	const root = parse(html);
	expect(root.querySelector(".file-widget__link")?.getAttribute("href")).toBe(
		"https://note.com/api/v2/attachments/download/example",
	);
	expect(root.querySelector(".file-widget__filename")?.text).toBe("資料.pdf");
	expect(root.querySelector(".file-widget__data")?.text).toBe(parse(body).text);
	expect(root.querySelector(".file-widget__data")?.getAttribute("style")).toBe(
		"white-space:pre-line",
	);
});

test("未知のページ構造と空本文を成功として保存しない", async () => {
	const client = new NoteClient("test", 0);
	await expect(
		captureHttpHtml(client, new URL("/unknown", server.url).href, detail, dir),
	).rejects.toThrow("記事本文が見つかりません");
	await expect(
		captureHttpHtml(
			client,
			new URL("/legacy", server.url).href,
			{ ...detail, body: "" },
			dir,
		),
	).rejects.toThrow("記事本文が見つかりません");
});

test("CSS 取得失敗時は絶対 URL を残し本文保存を続ける", async () => {
	const html = await captureHttpHtml(
		new NoteClient("test", 0),
		new URL("/broken", server.url).href,
		detail,
		dir,
	);
	expect(html).toContain(new URL("/missing.css", server.url).href);
	expect(html).toContain("購入済みの全文");
});

test("Cookie 登録は既存設定を保持し、重複を除去して即時反映する", async () => {
	const env = join(dir, ".env");
	await Bun.write(
		env,
		'# 設定\nOUT_DIR=./saved\n export NOTE_COOKIE = "old"\nNOTE_COOKIE=duplicate\n',
	);
	const previous = process.env.NOTE_COOKIE;
	try {
		saveCookie("Cookie: _note_session_v5=new; other=value", env);
		const saved = await readFile(env, "utf8");
		expect(saved).toContain("OUT_DIR=./saved");
		expect(saved.match(/NOTE_COOKIE=/g)).toHaveLength(1);
		expect(process.env.NOTE_COOKIE).toBe("_note_session_v5=new; other=value");
	} finally {
		if (previous === undefined) delete process.env.NOTE_COOKIE;
		else process.env.NOTE_COOKIE = previous;
	}
});

test("Cookie 登録で改行・引用符・セッション欠落を拒否する", () => {
	for (const value of [
		"other=value",
		"_note_session_v5=",
		'_note_session_v5="bad"',
		"_note_session_v5=value\nOUT_DIR=bad",
	]) {
		expect(() => saveCookie(value, join(dir, ".env"))).toThrow("Cookie ヘッダ");
	}
});

afterAll(() => {
	server.stop(true);
});
