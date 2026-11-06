/** Native theme IDs documented by Herdr 0.9.3; Default is a separate Gentle Shell policy. */
export const HERDR_NATIVE_THEMES = [
	"catppuccin", "terminal", "tokyo-night", "dracula", "nord", "gruvbox",
	"one-dark", "solarized", "kanagawa", "rose-pine", "vesper",
] as const;

export type HerdrNativeTheme = (typeof HERDR_NATIVE_THEMES)[number];
export type HerdrVisualsThemeChoice = "default" | HerdrNativeTheme;
