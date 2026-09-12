import { application } from "@yuu1111/knip-config/application";

export default {
	...application,
	// package.jsonのscriptから解決できない入口だけを明示する
	entry: ["scripts/get-cookie.js", "quality.config.ts"],
	// quality-checkが実行時にnode_modules/.binから解決する
	ignoreDependencies: [
		"@yuu1111/code-style-check",
		"@yuu1111/comment-check",
		"@yuu1111/document-style-check",
		"@yuu1111/tsdoc-check",
	],
};
