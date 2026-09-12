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
		"comment-check": {
			enable: ["cramped-comment", "japanese-period"]
		},
		"document-style-check": {
			enable: ["japanese-period"]
		 },
		"tsdoc-check": {
			error: ["missing-doc", "single-line-doc", "tsdoc-tag"]
		},
	},
});
