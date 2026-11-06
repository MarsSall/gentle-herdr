import assert from "node:assert/strict";
import test from "node:test";
import { parseColor } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HERDR_NATIVE_THEMES } from "../lib/herdr-native-themes.ts";
import { HERDR_SUMMARY_COLORS, type HerdrVisualsSettings } from "../lib/herdr-visuals-policy.ts";
import { openHerdrVisualsMenu, type HerdrMenuDependencies } from "../lib/herdr-visuals-menu.ts";

export function fixture(choices: (string | undefined)[] = []) {
 let settings: HerdrVisualsSettings = { theme: "default", summaryColor: "default" };
 const notes: string[] = [], titles: string[] = [], lists: string[][] = [], order: string[] = [], confirms: string[] = [];
 let malformed = false, consent = true;
 const ctx = { mode: "tui", hasUI: true, ui: {
  theme: { name: "dark", colors: Object.fromEntries(["accent", "text", "muted", "dim", "success", "warning", "error", "thinkingText", "borderAccent"].map(k => [k, parseColor("#123456")])) },
  select: async (title: string, items: string[]) => { titles.push(title); lists.push(items); const value = choices.shift(); return items.find(i => i === value || i.startsWith(`${value}:`) || i.startsWith(`${value} (`)) ?? value; },
  confirm: async (title: string, text: string) => { confirms.push(`${title}\n${text}`); return consent; },
  notify: (text: string) => notes.push(text),
 } } as unknown as ExtensionContext;
 const deps: HerdrMenuDependencies = {
  read: () => ({ settings: { ...settings }, malformed, readError: false, source: "default", globalFile: "/unused" }),
  write: next => { order.push("save"); settings = next; },
  availability: () => ({ available: true }),
  application: async () => { order.push("apply"); return { status: "requested" }; },
 };
 return { ctx, deps, notes, titles, lists, order, confirms, settings: () => settings,
  seed: (next: HerdrVisualsSettings) => { settings = next; }, bad: () => { malformed = true; }, cancel: () => { consent = false; } };
}

test("choices include every native theme and summary color, marked current; cancellation writes nothing", async () => {
 const h = fixture(["Theme", undefined, "Summary color", undefined, "Close"]);
 await openHerdrVisualsMenu(h.ctx, h.deps);
 assert.deepEqual(h.lists[1], ["Default (current)", ...HERDR_NATIVE_THEMES]);
 assert.deepEqual(h.lists[3], ["Default (current)", ...HERDR_SUMMARY_COLORS]);
 assert.doesNotMatch(h.lists.flat().join("\n"), /Task summary: (on|off)/);
 assert.deepEqual(h.order, []);
});

test("consent re-reads preferences and saves before applying the live palette", async () => {
 const h = fixture(["Theme", "nord", "Summary color", "warning", "Close"]);
 h.ctx.ui.confirm = async () => { h.seed({ ...h.settings(), summaryColor: "error" }); return true; };
 await openHerdrVisualsMenu(h.ctx, h.deps);
 assert.deepEqual(h.order, ["save", "apply", "save", "apply"]);
 assert.deepEqual(h.settings(), { theme: "nord", summaryColor: "warning" });
 assert.match(h.notes[0]!, /Preference saved.*reload requested/);
});

for (const reason of ["remote", "unavailable"] as const) test(`${reason} warning appears before every confirming choice`, async () => {
 const h = fixture(["Theme", "nord", "Apply now", "Remove from Herdr config", "Close"]);
 h.deps.availability = () => ({ available: false, reason });
 h.deps.application = async () => { assert.fail("guard must prevent application"); };
 await openHerdrVisualsMenu(h.ctx, h.deps);
 const pattern = reason === "remote" ? /client machine.*own config.*nothing.*applied/i : /Herdr was not detected locally/;
 for (const text of [...h.titles, ...h.confirms]) assert.match(text, pattern);
 assert.deepEqual(h.order, ["save"]);
 assert.match(h.notes[0]!, /not applied/);
});

test("cancelled preview and unhealthy stores never persist or apply", async () => {
 const h = fixture(["Theme", "nord", "Close"]); h.cancel();
 await openHerdrVisualsMenu(h.ctx, h.deps); assert.deepEqual(h.order, []);
 const bad = fixture(["Theme", "Apply now", "Close"]); bad.bad();
 await openHerdrVisualsMenu(bad.ctx, bad.deps);
 assert.deepEqual(bad.order, []); assert.match(bad.notes.join(), /malformed/);
});

test("failed persistence prevents application; malformed store arriving during consent is refused", async () => {
 const h = fixture(["Theme", "nord", "Close"]);
 h.deps.write = () => { throw new Error("write refused"); };
 await openHerdrVisualsMenu(h.ctx, h.deps);
 assert.deepEqual(h.order, []); assert.match(h.notes.join(), /write refused/);
 const race = fixture(["Theme", "nord", "Close"]);
 race.ctx.ui.confirm = async () => { race.bad(); return true; };
 await openHerdrVisualsMenu(race.ctx, race.deps);
 assert.deepEqual(race.order, []); assert.match(race.notes.join(), /malformed/);
});

for (const result of [{ status: "unchanged" }, { status: "partial", stage: "config", error: "bad config" }, { status: "partial", stage: "reload", error: "offline" }, { status: "unavailable" }] as const) test(`Apply now reports ${JSON.stringify(result)}`, async () => {
 const h = fixture(["Apply now", "Close"]); h.deps.application = async () => result;
 await openHerdrVisualsMenu(h.ctx, h.deps);
 assert.deepEqual(h.order, []);
 assert.match(h.notes.join(), result.status === "partial" ? new RegExp(result.stage) : result.status === "unavailable" ? /not applied/ : /already matches/);
});

test("removal works without reading malformed preferences or projecting a palette", async () => {
 const h = fixture(["Remove from Herdr config", "Close"]); h.bad();
 h.deps.application = async (_projection, action) => { assert.equal(action, "remove"); h.order.push("remove"); return { status: "requested" }; };
 await openHerdrVisualsMenu(h.ctx, h.deps);
 assert.deepEqual(h.order, ["remove"]); assert.match(h.notes.join(), /reload requested/);
});
