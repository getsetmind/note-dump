import { z } from "zod";

/**
 * @description note.com 購入済み API の 1 アイテム本体
 */
const PurchasedItemInnerSchema = z
	.object({
		key: z.string(),
		name: z.string().optional(),
		note_url: z.string().optional(),
		user: z
			.object({
				urlname: z.string().optional(),
			})
			.loose()
			.optional(),
	})
	.loose();

/**
 * @description 購入済みリストの 1 行
 *   `{ note: {...} }` ラッパー型と素の `{ key, ... }` 型を preprocess で吸収
 */
export const PurchasedItemSchema = z.preprocess((raw) => {
	if (
		raw !== null &&
		typeof raw === "object" &&
		"note" in raw &&
		(raw as { note: unknown }).note !== undefined
	) {
		return (raw as { note: unknown }).note;
	}
	return raw;
}, PurchasedItemInnerSchema);

/**
 * @description GET /api/v3/payments/purchase_notes のレスポンス
 *   data 配列以外のフィールドは将来追加されても無視する
 */
export const PurchasedListResponseSchema = z
	.object({
		data: z.array(z.unknown()).optional(),
	})
	.loose();

/**
 * @description GET /api/v3/notes/:key のレスポンス
 *   未知フィールドは loose で raw に残す
 */
export const NoteDetailResponseSchema = z.object({
	data: z
		.object({
			key: z.string().optional(),
			name: z.string().optional(),
			body: z.string().optional(),
			created_at: z.string().optional(),
			publish_at: z.string().optional(),
			price: z.union([z.string(), z.number()]).optional(),
			user: z
				.object({
					urlname: z.string().optional(),
					nickname: z.string().optional(),
				})
				.loose()
				.optional(),
		})
		.loose(),
});

/**
 * @description Mode の許容値
 */
export const ModeSchema = z.enum(["auto", "file", "args"]);

/**
 * @description Format の許容値
 */
export const FormatSchema = z.enum(["md", "html", "both"]);

/**
 * @description loadConfig が組み立てた生入力をバリデーションする
 *   coerce で文字列フラグを数値/真偽値に寄せる
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
	cdpUrl: z.string().url(),
});

/**
 * @description 検証済み Config
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * @description Mode 型
 */
export type Mode = z.infer<typeof ModeSchema>;

/**
 * @description Format 型
 */
export type Format = z.infer<typeof FormatSchema>;
