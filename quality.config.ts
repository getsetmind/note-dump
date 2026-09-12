import { defineConfig } from "@yuu1111/quality-check";

export default defineConfig({
	engines: {
		biome: true,
		typecheck: true,
		knip: true,
		"comment-check": true,
		"document-style-check": true,
		"tsdoc-check": true,
	},
	config: {
		"tsdoc-check": { error: ["single-line-doc"] },
	},
});
