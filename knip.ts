import { application } from "@yuu1111/knip-config/application";

export default {
	...application,
	entry: ["scripts/get-cookie.js", "tests/**/*.test.ts"],
};
