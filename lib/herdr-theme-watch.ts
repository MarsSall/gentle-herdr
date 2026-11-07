import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyMenuPreferences, checkedHerdrSettings, herdrMenuDependencies, notifyHerdrResult, type HerdrMenuDependencies } from "./herdr-visuals-menu.ts";

export interface HerdrWatchClock {
 every(callback: () => Promise<void>, intervalMs: number): { unref(): unknown };
 clear(timer: { unref(): unknown }): void;
}
const clock: HerdrWatchClock = {
 every: (callback, intervalMs) => setInterval(() => { void callback(); }, intervalMs),
 clear: timer => clearInterval(timer as ReturnType<typeof setInterval>),
};
/** Observe public palette values as well as name: Pi can update a theme in place.
 * Capture before awaiting application; overlapping ticks neither duplicate nor
 * overwrite the next observed change. A failed/skipped change is not retried.
 */
export function startHerdrThemeWatch(ctx: ExtensionContext, deps: HerdrMenuDependencies = herdrMenuDependencies(), timerClock = clock, intervalMs = 500): () => void {
 const fingerprint = () => JSON.stringify([ctx.ui.theme.name, ctx.ui.theme.colors]);
 let previous = fingerprint(), busy = false, stopped = false;
 const timer = timerClock.every(async () => {
  if (stopped || busy) return;
  try {
   const next = fingerprint();
   if (next === previous) return;
   previous = next;
   if (!deps.availability().available) return;
   const settings = checkedHerdrSettings(deps);
   if (settings.theme !== "default" && !Object.values(settings.machines ?? {}).some(machine => machine.theme === "default")) return;
   busy = true;
   const result = await applyMenuPreferences(ctx, deps, settings, true);
   if (!stopped && result.status !== "unavailable") notifyHerdrResult(ctx, result);
  } catch (error) {
   if (!stopped) ctx.ui.notify(`Herdr theme re-apply: ${error instanceof Error ? error.message : String(error)}`, "warning");
  } finally { busy = false; }
 }, intervalMs);
 timer.unref();
 return () => { if (!stopped) { stopped = true; timerClock.clear(timer); } };
}
