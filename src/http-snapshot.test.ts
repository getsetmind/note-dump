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
