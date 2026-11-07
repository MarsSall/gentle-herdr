import assert from "node:assert/strict";
import test from "node:test";
import { parseColor } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startHerdrThemeWatch } from "../lib/herdr-theme-watch.ts";
import type { HerdrMenuDependencies } from "../lib/herdr-visuals-menu.ts";

test("watch re-applies only effective Default machines even with native local; one failure notice per change", async () => {
 let tick!: () => Promise<void>, name = "first", local = 0, native = true;
 const calls: string[] = [], notices: string[] = [];
 const colors = Object.fromEntries(["accent", "text", "muted", "error", "success", "thinkingText", "borderAccent"].map(k => [k, parseColor("#123456")]));
 const ctx = { ui: { get theme() { return { name, colors }; }, notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
 const deps: HerdrMenuDependencies = {
  read: () => ({ settings: { theme: native ? "nord" : "default", summaryColor: "default", machines: { a: { theme: "default" }, b: { theme: "same" }, c: { theme: "default" } } }, malformed: false, readError: false, source: "default", globalFile: "/unused" }),
  write() { assert.fail(); }, availability: () => ({ available: true }), application: async () => { local++; return { status: "requested" }; },
  machines: async () => ["a", "b", "c"].map(id => ({ id, label: id, target: id, enabled: true })),
  remote: async machine => { calls.push(machine.id); return { id: machine.id, label: machine.label, status: "auth" }; },
 };
 const stop = startHerdrThemeWatch(ctx, deps, { every: cb => { tick = cb; return { unref() {} }; }, clear() {} });
 name = "next"; await tick(); await tick();
 assert.deepEqual(calls, ["a", "c"]); assert.equal(local, 0); assert.equal(notices.length, 1);
 native = false; name = "third"; await tick(); await tick();
 assert.deepEqual(calls, ["a", "c", "a", "b", "c"]); assert.equal(local, 1); assert.equal(notices.length, 2);
 stop();
});

test("watch applies once per palette/name change, never on start; stops and unrefs", async () => {
 let tick!: () => Promise<void>, unrefs = 0, stops = 0, calls = 0;
 let native = false, available = true, malformed = false;
 const colors = Object.fromEntries(["accent", "text", "muted", "error", "success", "thinkingText", "borderAccent"].map(k => [k, parseColor("#123456")]));
 let theme = { name: "first", colors };
 const ctx = { ui: { get theme() { return theme; }, notify() {} } } as unknown as ExtensionContext;
 const deps: HerdrMenuDependencies = {
  read: () => ({ settings: { theme: native ? "nord" : "default", summaryColor: "default" }, malformed, readError: false, source: "default", globalFile: "/unused" }),
  write: () => assert.fail("watch never saves"),
  availability: () => available ? { available: true } : { available: false, reason: "remote" },
  application: async () => { calls++; return { status: "requested" }; },
 };
 const stop = startHerdrThemeWatch(ctx, deps, { every: callback => { tick = callback; return { unref: () => { unrefs++; } }; }, clear: () => { stops++; } });
 assert.equal(calls, 0); assert.equal(unrefs, 1);
 await tick(); assert.equal(calls, 0);
 theme = { ...theme, name: "next" }; await tick(); await tick(); assert.equal(calls, 1);
 colors.accent = parseColor("#abcdef"); await tick(); assert.equal(calls, 2);
 native = true; theme = { ...theme, name: "native" }; await tick(); assert.equal(calls, 2);
 native = false; available = false; theme = { ...theme, name: "remote" }; await tick(); assert.equal(calls, 2);
 available = true; await tick(); assert.equal(calls, 2, "do not retry skipped changes");
 malformed = true; theme = { ...theme, name: "bad" }; await tick(); assert.equal(calls, 2);
 stop(); stop(); theme = { ...theme, name: "stopped" }; await tick(); assert.equal(calls, 2); assert.equal(stops, 1);
});

test("overlapping ticks serialize distinct changes and never duplicate an in-flight change", async () => {
 let tick!: () => Promise<void>, calls = 0, release!: () => void;
 const pending = new Promise<void>(done => { release = done; });
 const colors = Object.fromEntries(["accent", "text", "muted", "error", "success", "thinkingText", "borderAccent"].map(k => [k, parseColor("#123456")]));
 let name = "a";
 const ctx = { ui: { get theme() { return { name, colors }; }, notify() {} } } as unknown as ExtensionContext;
 const stop = startHerdrThemeWatch(ctx, {
  read: () => ({ settings: { theme: "default", summaryColor: "default" }, malformed: false, readError: false, source: "default", globalFile: "/unused" }),
  write() {}, availability: () => ({ available: true }),
  application: async () => { calls++; await pending; return { status: "unchanged" }; },
 }, { every: cb => { tick = cb; return { unref() {} }; }, clear() {} });
 name = "b"; const first = tick(); await tick(); assert.equal(calls, 1);
 name = "c"; await tick(); assert.equal(calls, 1);
 release(); await first; await tick(); assert.equal(calls, 2); stop();
});
