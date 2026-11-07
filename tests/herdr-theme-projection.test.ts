import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex, parseColor } from "@earendil-works/pi-tui";
import { HERDR_NATIVE_THEMES } from "../lib/herdr-native-themes.ts";
import { projectHerdrTaskSummaryStyle, projectHerdrTheme } from "../lib/herdr-theme-projection.ts";

type Palette = Pick<Theme, "colors">;
const values = {
	userMessageBg: "#112233", customMessageBg: "#223344", selectedBg: "#334455",
	accent: "#445566", text: "#556677", error: "#667788", success: "#778899",
	muted: "#8899aa", dim: "#99aabb", warning: "#aabbcc",
	thinkingText: "#a1a2a3", borderAccent: "#b1b2b3", customMessageLabel: "#c1c2c3",
	syntaxFunction: "#d1d2d3", syntaxOperator: "#e1e2e3",
};
function palette(overrides: Partial<typeof values> = {}): Palette {
	return { colors: Object.fromEntries(Object.entries({ ...values, ...overrides })
		.map(([role, value]) => [role, parseColor(value)])) as Palette["colors"] };
}
// Herdr text colors (sidebar included) from the Gentle palette. Working/done
// status and notification colors (yellow, teal, blue, peach) stay native.
const expected = {
	accent: "#445566", text: "#556677", red: "#667788", green: "#778899",
	subtext0: "#8899aa", overlay0: "#8899aa", overlay1: "#a1a2a3", mauve: "#b1b2b3",
};

test("default projects text colors over one-dark but keeps native status and notification colors", () => {
	const theme = palette();
	assert.deepEqual(projectHerdrTheme(theme, "default"), { name: "one-dark", custom: expected });
	assert.deepEqual(projectHerdrTheme(theme, "default"), projectHerdrTheme(theme, "default"));
	assert.equal(colorToHex(theme.colors.accent), values.accent);
});

test("every native choice returns only its name, dropping default custom overrides", () => {
	const theme = palette();
	const previous = projectHerdrTheme(theme, "default");
	for (const name of HERDR_NATIVE_THEMES) {
		assert.deepEqual(projectHerdrTheme(theme, name), { name });
	}
	assert.deepEqual(previous.custom, expected);
	const unreadable = { get colors(): Palette["colors"] { throw new Error("palette read"); } };
	assert.deepEqual(projectHerdrTheme(unreadable, "terminal"), { name: "terminal" });
});

test("a live colors getter supplies a fresh palette on each projection", () => {
	let current = palette();
	const live = { get colors() { return current.colors; } };
	const first = projectHerdrTheme(live, "default");
	const firstStyle = projectHerdrTaskSummaryStyle(live, "default");
	current = palette({ accent: "#abcdef", userMessageBg: "#010203" });
	assert.deepEqual(projectHerdrTheme(live, "default"), {
		name: "one-dark", custom: { ...expected, accent: "#abcdef" },
	});
	assert.deepEqual(projectHerdrTaskSummaryStyle(live, "default"), { fg: "#abcdef", dim: true, bold: false });
	assert.deepEqual(first, { name: "one-dark", custom: expected });
	assert.deepEqual(firstStyle, { fg: values.accent, dim: true, bold: false });
});

test("default title uses Gentle accent and one dim, non-bold style regardless of native theme", () => {
	const theme = palette();
	for (const name of HERDR_NATIVE_THEMES) {
		projectHerdrTheme(theme, name);
		const style = projectHerdrTaskSummaryStyle(theme, "default");
		assert.deepEqual(style, { fg: values.accent, dim: true, bold: false });
		// The consumer can reuse this single style for both wrapped metadata lines.
		const rows = ["$summary", "$summary2"].map(token => ({ token, ...style }));
		assert.deepEqual(rows[0], { token: "$summary", fg: values.accent, dim: true, bold: false });
		assert.deepEqual(rows[1], { ...rows[0], token: "$summary2" });
	}
});

test("explicit foreground roles use Gentle colors without invented native swatches", () => {
	const theme = palette();
	for (const color of ["accent", "text", "muted", "dim", "success", "warning", "error"] as const) {
		assert.deepEqual(projectHerdrTaskSummaryStyle(theme, color), {
			fg: values[color], dim: false, bold: false,
		});
	}
});

test("SDK color objects including ANSI index and OKLCH convert through public colorToHex", () => {
	const theme = palette();
	const colors = { ...theme.colors, accent: parseColor(39), text: parseColor("oklch(62% 0.1 200)") };
	const projected = projectHerdrTheme({ colors }, "default");
	assert.equal(projected.custom?.accent, colorToHex(colors.accent));
	assert.equal(projected.custom?.text, colorToHex(colors.text));
	assert.equal(projectHerdrTaskSummaryStyle({ colors }, "text").fg, colorToHex(colors.text));
});

test("unknown choices and roles fail before returning any proposal", () => {
	assert.throws(() => projectHerdrTheme(palette(), "unknown" as never), /Unknown Herdr theme/);
	assert.throws(() => projectHerdrTaskSummaryStyle(palette(), "border" as never), /Unknown Herdr summary color/);
});

test("bad or missing concrete colors cannot leak malformed hex into a proposal", () => {
	const theme = palette();
	for (const bad of [undefined, { kind: "rgb", r: NaN, g: 0, b: 0 }]) {
		const colors = { ...theme.colors, accent: bad } as Palette["colors"];
		assert.throws(() => projectHerdrTheme({ colors }, "default"));
		assert.throws(() => projectHerdrTaskSummaryStyle({ colors }, "default"));
	}
	const missingBackground = { ...theme.colors, selectedBg: undefined } as unknown as Palette["colors"];
	assert.deepEqual(projectHerdrTheme({ colors: missingBackground }, "default"), { name: "one-dark", custom: expected });
	for (const role of ["userMessageBg", "customMessageBg", "selectedBg"] as const) {
		const colors = { ...theme.colors };
		Object.defineProperty(colors, role, { get() { throw new Error("message background read"); } });
		assert.deepEqual(projectHerdrTheme({ colors }, "default"), { name: "one-dark", custom: expected });
	}
});

test("default adds the Gentleman.Dots fixed values that the Gentle palette does not define", () => {
	const cute = { panel_bg: "#000000", surface0: "#241822", surface1: "#342230", surface_dim: "#20161E", overlay0: "#B99AA9" };
	assert.deepEqual(projectHerdrTheme({ ...palette(), name: "Gentleman-Cute" }, "default"), { name: "one-dark", custom: { ...expected, ...cute } });
	// Sexy keeps Cute's surfaces but shows its own hot pink in sidebar text, details and the active row.
	const sexy = { ...cute, overlay0: "#D9709F", overlay1: "#FF4F9A", active_row_bg: "#2E0F1F", selection_bg: "#2E0F1F" };
	assert.deepEqual(projectHerdrTheme({ ...palette(), name: "Gentleman-Sexy" }, "default"), { name: "one-dark", custom: { ...expected, ...sexy } });
	assert.deepEqual(projectHerdrTheme({ ...palette(), name: "Gentle" }, "default"), { name: "one-dark", custom: { ...expected, panel_bg: "#06080f" } });
	for (const name of ["dark", "light", "Other-Theme", undefined]) {
		assert.deepEqual(projectHerdrTheme({ ...palette(), name }, "default"), { name: "one-dark", custom: expected });
	}
	// Native choices stay name-only whatever the active Gentle theme is.
	assert.deepEqual(projectHerdrTheme({ ...palette(), name: "Gentleman-Cute" }, "nord"), { name: "nord" });
});
