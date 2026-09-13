import { application } from "@yuu1111/knip-config/application";

export default {
	...application,
	// package.jsonのscriptから解決できない入口だけを明示する
	entry: ["scripts/get-cookie.js"],
};
