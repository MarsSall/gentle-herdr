import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HERDR_NATIVE_THEMES } from "./herdr-native-themes.ts";
import { listHerdrMachines, type HerdrMachine } from "./herdr-machines.ts";
import { applyRemoteHerdrVisuals, type HerdrRemoteResult } from "./herdr-remote-config.ts";
import { projectHerdrTheme, projectHerdrTaskSummaryStyle } from "./herdr-theme-projection.ts";
import type { HerdrVisualsProjection } from "./herdr-visuals-config.ts";
import { HERDR_SUMMARY_COLORS, resolveHerdrVisualsSettings, writeHerdrVisualsSettings,
 type HerdrVisualsResolution, type HerdrVisualsSettings, type HerdrMachineTheme } from "./herdr-visuals-policy.ts";
import { applyHerdrVisualsPreferences, removeHerdrVisualsBlocks, localHerdrVisualsApplication,
 localHerdrVisualsAvailability, type HerdrVisualsApplication, type HerdrVisualsAvailability,
 type HerdrVisualsApplicationResult } from "./herdr-visuals-application.ts";
import { buildHerdrPreview, defaultHerdrLabel } from "./herdr-preview.ts";
import { createHerdrChoiceList } from "./herdr-choice-list.ts";

// Ported from the original Gentle Shell Herdr card; no Gentle Shell internals.
export const HERDR_REMOTE_PREVIEW = "Remote session: Herdr reads theme and sidebar from the client machine's own config; nothing will be applied from here. Configure this machine's pane borders via /gentle:herdr → Machines on the client.";
export interface HerdrMenuDependencies {
 read(): HerdrVisualsResolution;
 write(settings: HerdrVisualsSettings): void;
 availability(): HerdrVisualsAvailability;
 application: HerdrVisualsApplication;
 machines?(): Promise<HerdrMachine[]>;
 remote?(machine: HerdrMachine, projection: HerdrVisualsProjection): Promise<HerdrRemoteResult>;
}
export type HerdrMenuResult = HerdrVisualsApplicationResult & { machines?: HerdrRemoteResult[]; discoveryFailed?: boolean };
export function herdrMenuDependencies(env: NodeJS.ProcessEnv = process.env): HerdrMenuDependencies {
 return { read: () => resolveHerdrVisualsSettings(), write: settings => { writeHerdrVisualsSettings(settings); },
  availability: () => localHerdrVisualsAvailability(env), application: localHerdrVisualsApplication(env),
  machines: () => listHerdrMachines(undefined, env.HERDR_BIN_PATH ?? "herdr"),
  remote: (machine, projection) => applyRemoteHerdrVisuals(machine, projection, undefined, env.HERDR_BIN_PATH ?? "herdr") };
}
function scope(deps: HerdrMenuDependencies): string {
 const availability = deps.availability();
 return availability.available ? "Local client; preview only until confirmed. Applying preferences updates this computer, then enabled saved machines."
  : availability.reason === "remote" ? HERDR_REMOTE_PREVIEW : "Herdr was not detected locally; nothing will be applied from here.";
}
export function checkedHerdrSettings(deps: HerdrMenuDependencies): HerdrVisualsSettings {
 const current = deps.read();
 if (current.malformed || current.readError) throw new Error("Cannot update unreadable or malformed Herdr preferences");
 return current.settings;
}
export function notifyHerdrResult(ctx: ExtensionContext, result: HerdrMenuResult, prefix = ""): void {
 let message: string;
 switch (result.status) {
  case "requested": message = "Herdr configuration updated; reload requested"; break;
  case "unchanged": message = "Herdr configuration already matches; no reload requested"; break;
  case "unavailable": message = result.reason === "remote" ? HERDR_REMOTE_PREVIEW + " Herdr configuration not applied here" : "Herdr unavailable; configuration not applied"; break;
  case "partial": message = result.stage === "config"
   ? `Herdr config stage failed; configuration not updated; reload not requested: ${result.error}`
   : `Herdr reload stage failed; configuration updated; client state unknown: ${result.error}`; break;
 }
 const machineSummary = result.machines?.map(machine => `${machine.label}: ${machine.status}`).join("; ");
 if (machineSummary) message += `. Machines: ${machineSummary}`;
 if (result.discoveryFailed) message += ". Machines: discovery failed; no remote configs accessed";
 const failed = result.discoveryFailed || result.machines?.some(machine => !["applied", "unchanged"].includes(machine.status));
 ctx.ui.notify(prefix + message, result.status === "partial" || failed ? "warning" : "info");
}
/** Guard again immediately before projecting or invoking the local application. */
export async function applyMenuPreferences(ctx: ExtensionContext, deps: HerdrMenuDependencies, settings: HerdrVisualsSettings, defaultsOnly = false): Promise<HerdrMenuResult> {
 const availability = deps.availability();
 if (!availability.available) return { status: "unavailable", ...(availability.reason === "remote" ? { reason: "remote" as const } : {}) };
 const local = !defaultsOnly || settings.theme === "default"
  ? await applyHerdrVisualsPreferences(settings, ctx.ui.theme, deps.application) : { status: "unchanged" as const };
 const machines: HerdrRemoteResult[] = [];
 if (!deps.machines || !deps.remote) return local;
 let saved: HerdrMachine[];
 try { saved = await deps.machines(); } catch { return { ...local, discoveryFailed: true }; }
 for (const machine of saved) {
  if (!machine.enabled) continue;
  const choice = Object.hasOwn(settings.machines ?? {}, machine.id) ? settings.machines![machine.id]!.theme : "same";
  const theme = choice === "same" ? settings.theme : choice;
  if (defaultsOnly && theme !== "default") continue;
  // Recheck session guards before each remote operation too.
  if (!deps.availability().available) break;
  try {
   machines.push(await deps.remote(machine, { theme: projectHerdrTheme(ctx.ui.theme, theme),
    taskSummaryStyle: projectHerdrTaskSummaryStyle(ctx.ui.theme, settings.summaryColor) }));
  } catch { machines.push({ id: machine.id, label: machine.label, status: "unreachable" }); }
 }
 return { ...local, machines };
}

/** Public Pi selectors and confirmation previews; opening never persists or applies. */
export async function openHerdrVisualsMenu(ctx: ExtensionContext, deps = herdrMenuDependencies()): Promise<void> {
 if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("/gentle:herdr needs an interactive terminal", "warning"); return; }
 for (;;) {
  const current = deps.read();
  const healthy = !current.malformed && !current.readError;
  const entries = [`Theme: ${healthy ? current.settings.theme === "default" ? defaultHerdrLabel(ctx.ui.theme) : current.settings.theme : "unavailable"}`, `Summary color: ${healthy ? current.settings.summaryColor : "unavailable"}`,
   "Machines", "Apply now", "Remove from Herdr config", "Close"];
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
   } else if (choice === "Machines") {
    if (!deps.availability().available) { ctx.ui.notify(scope(deps), "warning"); continue; }
    const settings = checkedHerdrSettings(deps);
    const machines = await deps.machines?.() ?? [];
    if (!machines.length) { ctx.ui.notify("No enabled saved Herdr machines", "info"); continue; }
    const labels = machines.map(machine => {
     const theme = Object.hasOwn(settings.machines ?? {}, machine.id) ? settings.machines![machine.id]!.theme : "same";
     return `${machine.label}: ${theme === "same" ? "Same as this computer" : theme === "default" ? defaultHerdrLabel(ctx.ui.theme) : theme} [${machine.id}]`;
    });
    const selected = await ctx.ui.select(`Machines\n${scope(deps)}`, labels);
    const machine = machines[labels.indexOf(selected ?? "")];
    if (!machine) continue;
    const currentTheme = Object.hasOwn(settings.machines ?? {}, machine.id) ? settings.machines![machine.id]!.theme : "same";
    const values: HerdrMachineTheme[] = ["same", "default", ...HERDR_NATIVE_THEMES];
    const names = values.map(theme => theme === "same" ? "Same as this computer" : theme === "default" ? defaultHerdrLabel(ctx.ui.theme) : theme);
    const previewAt = (index: number) => buildHerdrPreview(ctx.ui.theme, settings, "theme", values[index] === "same" ? settings.theme : values[index]!);
    let index: number | undefined;
    const title = `${machine.label} theme\n${scope(deps)}`;
    if (typeof ctx.ui.custom === "function") {
     index = await ctx.ui.custom<number | undefined>((tui, _theme, keybindings, done) => createHerdrChoiceList({
      title, options: names, current: values.indexOf(currentTheme), preview: previewAt,
      keybindings, requestRender: () => tui.requestRender(), done,
     }));
    } else {
     const marked = names.map((name, i) => `${name}${values[i] === currentTheme ? " (current)" : ""}`);
     index = marked.indexOf(await ctx.ui.select(title, marked) ?? "");
    }
    if (index === undefined || index < 0 || index >= values.length) continue;
    if (!await ctx.ui.confirm(`Save ${machine.label} theme: ${names[index]}?\n${scope(deps)}`, previewAt(index).join("\n"))) continue;
    const fresh = checkedHerdrSettings(deps);
    deps.write({ ...fresh, machines: { ...fresh.machines, [machine.id]: { theme: values[index]! } } });
    notifyHerdrResult(ctx, await applyMenuPreferences(ctx, deps, checkedHerdrSettings(deps)), "Preference saved; ");
   } else if (choice === "Apply now") {
    checkedHerdrSettings(deps);
    if (await ctx.ui.confirm(`Apply now?\n${scope(deps)}`, "Apply saved preferences and request Herdr reload if configuration changes?"))
     notifyHerdrResult(ctx, await applyMenuPreferences(ctx, deps, checkedHerdrSettings(deps)));
   } else if (choice === "Remove from Herdr config") {
    if (!await ctx.ui.confirm(`Remove from Herdr config?\n${scope(deps)}`, "Remove package-owned blocks on this computer only; keep preferences, remote configs and user settings. Reload if changed.")) continue;
    const availability = deps.availability();
    notifyHerdrResult(ctx, availability.available ? await removeHerdrVisualsBlocks(deps.application)
     : { status: "unavailable", ...(availability.reason === "remote" ? { reason: "remote" as const } : {}) });
   }
  } catch (error) { ctx.ui.notify(`Herdr visuals: ${error instanceof Error ? error.message : String(error)}`, "error"); }
 }
}
