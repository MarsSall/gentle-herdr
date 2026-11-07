import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HERDR_NATIVE_THEMES } from "./herdr-native-themes.ts";
import { HERDR_SUMMARY_COLORS, resolveHerdrVisualsSettings, writeHerdrVisualsSettings,
 type HerdrVisualsResolution, type HerdrVisualsSettings } from "./herdr-visuals-policy.ts";
import { applyHerdrVisualsPreferences, removeHerdrVisualsBlocks, localHerdrVisualsApplication,
 localHerdrVisualsAvailability, type HerdrVisualsApplication, type HerdrVisualsAvailability,
 type HerdrVisualsApplicationResult } from "./herdr-visuals-application.ts";
import { buildHerdrPreview, defaultHerdrLabel } from "./herdr-preview.ts";
import { createHerdrChoiceList } from "./herdr-choice-list.ts";

// Ported from the original Gentle Shell Herdr card; no Gentle Shell internals.
export const HERDR_REMOTE_PREVIEW = "Remote session: Herdr reads theme and sidebar from the client machine's own config; nothing will be applied from here. Run /gentle:herdr on that machine.";
export interface HerdrMenuDependencies {
 read(): HerdrVisualsResolution;
 write(settings: HerdrVisualsSettings): void;
 availability(): HerdrVisualsAvailability;
 application: HerdrVisualsApplication;
}
export function herdrMenuDependencies(env: NodeJS.ProcessEnv = process.env): HerdrMenuDependencies {
 return { read: () => resolveHerdrVisualsSettings(), write: settings => { writeHerdrVisualsSettings(settings); },
  availability: () => localHerdrVisualsAvailability(env), application: localHerdrVisualsApplication(env) };
}
function scope(deps: HerdrMenuDependencies): string {
 const availability = deps.availability();
 return availability.available ? "Local client; preview only until confirmed."
  : availability.reason === "remote" ? HERDR_REMOTE_PREVIEW : "Herdr was not detected locally; nothing will be applied from here.";
}
export function checkedHerdrSettings(deps: HerdrMenuDependencies): HerdrVisualsSettings {
 const current = deps.read();
 if (current.malformed || current.readError) throw new Error("Cannot update unreadable or malformed Herdr preferences");
 return current.settings;
}
export function notifyHerdrResult(ctx: ExtensionContext, result: HerdrVisualsApplicationResult, prefix = ""): void {
 let message: string;
 switch (result.status) {
  case "requested": message = "Herdr configuration updated; reload requested"; break;
  case "unchanged": message = "Herdr configuration already matches; no reload requested"; break;
  case "unavailable": message = result.reason === "remote" ? HERDR_REMOTE_PREVIEW + " Herdr configuration not applied here" : "Herdr unavailable; configuration not applied"; break;
  case "partial": message = result.stage === "config"
   ? `Herdr config stage failed; configuration not updated; reload not requested: ${result.error}`
   : `Herdr reload stage failed; configuration updated; client state unknown: ${result.error}`; break;
 }
 ctx.ui.notify(prefix + message, result.status === "partial" ? "warning" : "info");
}
/** Guard again immediately before projecting or invoking the local application. */
export async function applyMenuPreferences(ctx: ExtensionContext, deps: HerdrMenuDependencies, settings: HerdrVisualsSettings): Promise<HerdrVisualsApplicationResult> {
 const availability = deps.availability();
 if (!availability.available) return { status: "unavailable", ...(availability.reason === "remote" ? { reason: "remote" as const } : {}) };
 return applyHerdrVisualsPreferences(settings, ctx.ui.theme, deps.application);
}

/** Public Pi selectors and confirmation previews; opening never persists or applies. */
export async function openHerdrVisualsMenu(ctx: ExtensionContext, deps = herdrMenuDependencies()): Promise<void> {
 if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("/gentle:herdr needs an interactive terminal", "warning"); return; }
 for (;;) {
  const current = deps.read();
  const healthy = !current.malformed && !current.readError;
  const entries = [`Theme: ${healthy ? current.settings.theme === "default" ? defaultHerdrLabel(ctx.ui.theme) : current.settings.theme : "unavailable"}`, `Summary color: ${healthy ? current.settings.summaryColor : "unavailable"}`,
   "Apply now", "Remove from Herdr config", "Close"];
  const choice = await ctx.ui.select(`Herdr visuals\n${scope(deps)}`, entries);
  if (choice === undefined || choice === "Close") return;
  try {
   if (choice === entries[0] || choice === entries[1]) {
    const key = choice === entries[0] ? "theme" : "summaryColor";
    const settings = checkedHerdrSettings(deps);
    const values = ["default", ...(key === "theme" ? HERDR_NATIVE_THEMES : HERDR_SUMMARY_COLORS)];
    const labels = values.map(value => value === "default" ? key === "theme" ? defaultHerdrLabel(ctx.ui.theme) : "Default" : value);
    const title = `${key === "theme" ? "Theme" : "Summary color"}\n${scope(deps)}`;
    const previewAt = (index: number) => buildHerdrPreview(ctx.ui.theme, settings, key, values[index]!);
    let index: number | undefined;
    if (typeof ctx.ui.custom === "function") {
     index = await ctx.ui.custom<number | undefined>((tui, _theme, keybindings, done) => createHerdrChoiceList({
      title, options: labels, current: values.indexOf(settings[key]), preview: previewAt,
      keybindings, requestRender: () => tui.requestRender(), done,
     }));
    } else {
     const marked = labels.map((label, i) => `${label}${values[i] === settings[key] ? " (current)" : ""}`);
     const selected = await ctx.ui.select(title, marked);
     index = selected === undefined ? undefined : marked.indexOf(selected);
    }
    if (index === undefined || index < 0 || index >= values.length) continue;
    const value = values[index]!;
    const preview = previewAt(index).join("\n");
    if (!await ctx.ui.confirm(`Save ${key === "theme" ? "theme" : "summary color"}: ${value}?\n${scope(deps)}`, preview)) continue;
    // Preserve any unrelated preference changed while the user was deciding.
    deps.write({ ...checkedHerdrSettings(deps), [key]: value });
    const fresh = checkedHerdrSettings(deps);
    notifyHerdrResult(ctx, await applyMenuPreferences(ctx, deps, fresh), "Preference saved; ");
   } else if (choice === "Apply now") {
    checkedHerdrSettings(deps);
    if (await ctx.ui.confirm(`Apply now?\n${scope(deps)}`, "Apply saved preferences and request Herdr reload if configuration changes?"))
     notifyHerdrResult(ctx, await applyMenuPreferences(ctx, deps, checkedHerdrSettings(deps)));
   } else if (choice === "Remove from Herdr config") {
    if (!await ctx.ui.confirm(`Remove from Herdr config?\n${scope(deps)}`, "Remove package-owned blocks only; keep preferences and user settings. Reload if changed.")) continue;
    const availability = deps.availability();
    notifyHerdrResult(ctx, availability.available ? await removeHerdrVisualsBlocks(deps.application)
     : { status: "unavailable", ...(availability.reason === "remote" ? { reason: "remote" as const } : {}) });
   }
  } catch (error) { ctx.ui.notify(`Herdr visuals: ${error instanceof Error ? error.message : String(error)}`, "error"); }
 }
}
