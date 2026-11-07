import type { projectHerdrTheme } from "./herdr-theme-projection.ts";
import { projectHerdrTheme as projectTheme, projectHerdrTaskSummaryStyle } from "./herdr-theme-projection.ts";
import type { HerdrVisualsSettings } from "./herdr-visuals-policy.ts";

type Palette = Parameters<typeof projectHerdrTheme>[0];
type PreviewKey = "theme" | "summaryColor";
export function defaultHerdrLabel(theme: { readonly name?: string }): string {
 return `Default (follows your Gentle Shell theme${theme.name ? `: ${theme.name}` : ""})`;
}
function color(hex: string, background = false): string {
 const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
 return `\x1b[${background ? 48 : 38};2;${rgb.join(";")}m`;
}
/** Preview only known projections, never Herdr's unexposed native palettes. No I/O. */
export function buildHerdrPreview(theme: Palette, settings: HerdrVisualsSettings, key: PreviewKey, value: string): string[] {
 const selected = { ...settings, [key]: value } as HerdrVisualsSettings;
 if (key === "theme" && selected.theme !== "default")
  return [`Looks like Herdr's built-in ${selected.theme} theme (colors come from Herdr)`];
 const projection = selected.theme === "default" ? projectTheme(theme, "default").custom : undefined;
 const background = projection?.panel_bg ? color(projection.panel_bg, true) : "";
 const paint = (text: string, fg: string, dim = false, bold = false) =>
  `${background}${color(fg)}${dim ? "\x1b[2m" : ""}${bold ? "\x1b[1m" : ""}${text}\x1b[0m`;
 const style = projectHerdrTaskSummaryStyle(theme, selected.summaryColor);
 const rows = ["◐ Continue the same task title", "  and its second row"].map(text => paint(text, style.fg, style.dim, style.bold));
 if (key === "theme" && projection) return [paint("pi", projection.accent), paint("  Secondary text", projection.subtext0), ...rows];
 return projection ? rows : [...rows, "Preview uses terminal default background; native theme colors come from Herdr."];
}
