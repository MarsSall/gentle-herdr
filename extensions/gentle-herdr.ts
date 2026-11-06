import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { herdrMenuDependencies, openHerdrVisualsMenu } from "../lib/herdr-visuals-menu.ts";
import { startHerdrThemeWatch } from "../lib/herdr-theme-watch.ts";

interface HerdrExtensionHooks {
 menu: typeof openHerdrVisualsMenu;
 watch: typeof startHerdrThemeWatch;
}
export default function gentleHerdr(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env,
 hooks: HerdrExtensionHooks = { menu: openHerdrVisualsMenu, watch: startHerdrThemeWatch }): void {
 const deps = herdrMenuDependencies(env);
 pi.registerCommand("gentle:herdr", {
  description: "Customize local Herdr theme and summary colors",
  handler: async (_args, ctx) => {
   if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("/gentle:herdr needs an interactive terminal", "warning"); return; }
   await hooks.menu(ctx, deps);
  },
 });
 if (env.GENTLE_PI_AGENTS_CHILD === "1") return;
 let stop: (() => void) | undefined;
 pi.on("session_start", (_event, ctx) => {
  stop?.(); stop = undefined;
  if (ctx.mode === "tui" && ctx.hasUI) stop = hooks.watch(ctx, deps);
 });
 pi.on("session_shutdown", () => { stop?.(); stop = undefined; });
}
