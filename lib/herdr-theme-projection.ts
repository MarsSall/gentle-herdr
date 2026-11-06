import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
import { HERDR_NATIVE_THEMES } from "./herdr-native-themes.ts";
import type { HerdrNativeTheme, HerdrVisualsThemeChoice } from "./herdr-native-themes.ts";
import type { HerdrSummaryColor } from "./herdr-visuals-policy.ts";

type Palette = Pick<Theme, "colors"> & { readonly name?: string };
type HerdrForeground = "accent" | "text" | "red" | "green" | "subtext0" | "overlay0" | "overlay1" | "mauve";
type HerdrBackground = "sidebar_bg" | "panel_bg" | "active_row_bg" | "selection_bg" | "surface0" | "surface1" | "surface_dim";
// Optional backgrounds retain the historical explicit planner input contract and
// carry the fixed Gentleman.Dots values; Gentle message backgrounds are never used.
type Projection = { name: HerdrNativeTheme; custom?: Record<HerdrForeground, string> & Partial<Record<HerdrBackground, string>> };

// Values from the Gentleman.Dots Herdr profiles that the Gentle palette does not
// define. Cute and Sexy share the gentleman-cute profile; the neutral Gentle theme
// uses the gentleman profile. Other Pi themes get none.
const DOTS_CUTE = { panel_bg: "#000000", surface0: "#241822", surface1: "#342230", surface_dim: "#20161E", overlay0: "#B99AA9" };
const DOTS_FIXED: Readonly<Record<string, Readonly<Partial<Record<HerdrBackground | "overlay0", string>>>>> = {
	"Gentleman-Cute": DOTS_CUTE, "Gentleman-Sexy": DOTS_CUTE, Gentle: { panel_bg: "#06080f" },
};
type TitleStyle = { fg: string; dim: boolean; bold: boolean };
const SUMMARY_ROLES: readonly HerdrSummaryColor[] = ["accent", "text", "muted", "dim", "success", "warning", "error"];

function hex(colors: Palette["colors"], role: keyof Palette["colors"]): string {
	const value = colorToHex(colors[role]);
	if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new TypeError(`Invalid concrete Gentle color: ${role}`);
	return value;
}

/** Pure text color projection for Herdr 0.9.3 over the one-dark base that
 * Gentleman.Dots uses, plus its fixed values for the active Gentle theme; not
 * pixel-complete Herdr/Gentle equivalence. Native choices supply no overrides.
 * No theme activation, configuration access, or client application occurs here.
 */
export function projectHerdrTheme(theme: Palette, choice: HerdrVisualsThemeChoice): Projection {
	if (choice !== "default") {
		if (!HERDR_NATIVE_THEMES.includes(choice)) throw new TypeError("Unknown Herdr theme choice");
		return { name: choice };
	}
	// Take one palette snapshot per call; never retain a live theme's old colors.
	const colors = theme.colors;
	const fixed = Object.hasOwn(DOTS_FIXED, theme.name ?? "") ? DOTS_FIXED[theme.name!] : {};
	return {
		name: "one-dark",
		custom: {
			accent: hex(colors, "accent"),
			text: hex(colors, "text"),
			red: hex(colors, "error"),
			green: hex(colors, "success"),
			// Herdr's sidebar draws most text with overlay0/subtext0/overlay1 and
			// branches with mauve. Working/done status and notification colors
			// (yellow, teal, blue, peach) stay with the native base theme.
			subtext0: hex(colors, "muted"),
			overlay0: hex(colors, "muted"),
			overlay1: hex(colors, "thinkingText"),
			mauve: hex(colors, "borderAccent"),
			...fixed,
		},
	};
}

/** One title style to reuse for both $summary and its wrapped $summary2 line.
 * Default follows Gentle accent even when a native Herdr theme is selected.
 */
export function projectHerdrTaskSummaryStyle(theme: Palette, color: "default" | HerdrSummaryColor): TitleStyle {
	if (color !== "default" && !SUMMARY_ROLES.includes(color)) throw new TypeError("Unknown Herdr summary color");
	return { fg: hex(theme.colors, color === "default" ? "accent" : color), dim: color === "default", bold: false };
}
