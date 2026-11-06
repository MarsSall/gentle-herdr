import assert from "node:assert/strict";
import test from "node:test";
import { HERDR_NATIVE_THEMES } from "../lib/herdr-native-themes.ts";

test("native theme choices match the documented Herdr 0.9.3 built-ins", () => {
	assert.deepEqual(HERDR_NATIVE_THEMES, [
		"catppuccin", "terminal", "tokyo-night", "dracula", "nord", "gruvbox",
		"one-dark", "solarized", "kanagawa", "rose-pine", "vesper",
	]);
});
