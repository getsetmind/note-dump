import { z } from "zod";

/**
 * note.com のユーザー情報
 * urlname だけを使う箇所と nickname も使う箇所があるため両方を持ち、未知フィールドは loose で残す
 */
const UserSchema = z
	.object({
		urlname: z.string().optional(),
		nickname: z.string().optional(),
	})
	.loose();

/**
 * note.com 購入済み API の 1 アイテム本体
 */
const PurchasedItemInnerSchema = z
	.object({
		key: z.string(),
		name: z.string().optional(),
		note_url: z.string().optional(),
		user: UserSchema.optional(),
	})
	.loose();

/**
 * `{ note: {...} }` ラッパーなら中身を、素のオブジェクトならそのまま返す
 */
function unwrapPurchasedItem(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	if (!("note" in raw)) return raw;
	return raw.note !== undefined ? raw.note : raw;
}

/**
 * 購入済みリストの 1 行
 * `{ note: {...} }` ラッパー型と素の `{ key, ... }` 型を preprocess で吸収する
 */
export const PurchasedItemSchema = z.preprocess(
	unwrapPurchasedItem,
	PurchasedItemInnerSchema,
);

/**
 * GET /api/v3/payments/purchase_notes のレスポンス
 * data 配列以外のフィールドは将来追加されても無視する
 */
export const PurchasedListResponseSchema = z
	.object({
		data: z.array(z.unknown()).optional(),
	})
	.loose();

/**
 * GET /api/v3/notes/:key の data 本体
 * 未知フィールドは loose で raw に残す
 */
const NoteDetailDataSchema = z
	.object({
		key: z.string().optional(),
		name: z.string().optional(),
		body: z.string().optional(),
		created_at: z.string().optional(),
		publish_at: z.string().optional(),
		price: z.union([z.string(), z.number()]).optional(),
		user: UserSchema.optional(),
	})
	.loose();

/**
 * GET /api/v3/notes/:key のレスポンス
 */
export const NoteDetailResponseSchema = z.object({
	data: NoteDetailDataSchema,
});

/**
 * Mode の許容値
 */
export const ModeSchema = z.enum(["auto", "file", "args"]);

/**
 * Format の許容値
 */
export const FormatSchema = z.enum(["md", "html", "both"]);

/**
 * loadConfig が組み立てた生入力をバリデーションする
 * coerce で文字列フラグを数値/真偽値に寄せる
 */
export const ConfigSchema = z.object({
	cookie: z.string().min(1, "NOTE_COOKIE が未設定"),
	outDir: z.string().min(1),
	concurrency: z.coerce.number().int().positive(),
	requestDelayMs: z.coerce.number().int().nonnegative(),
	mode: ModeSchema,
	urlsFile: z.string().min(1),
	limit: z.coerce.number().int().positive().optional(),
	positional: z.array(z.string()),
	format: FormatSchema,
	youtubeDl: z.coerce.boolean(),
	cdpUrl: z.url(),
});

/**
 * 検証済みの設定
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Format 型
 */
export type Format = z.infer<typeof FormatSchema>;
