import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleHerdr from "../extensions/gentle-herdr.ts";

test("registers gentle:herdr, refuses non-TUI modes and owns watcher startup/shutdown", async () => {
 const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
 const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
 const pi = { registerCommand: (name: string, command: never) => commands.set(name, command), on: (name: string, handler: never) => events.set(name, handler) } as unknown as ExtensionAPI;
 let starts = 0, stops = 0, menus = 0; const notes: string[] = [];
 gentleHerdr(pi, {}, { menu: async () => { menus++; }, watch: () => { starts++; return () => { stops++; }; } });
 assert.deepEqual([...commands.keys()], ["gentle:herdr"]); assert.equal(starts, 0);
 const ctx = (mode: string) => ({ mode, hasUI: mode === "tui" || mode === "rpc", ui: { notify: (text: string) => notes.push(text) } }) as unknown as ExtensionContext;
 for (const mode of ["rpc", "print", "json"]) {
  await commands.get("gentle:herdr")!.handler("", ctx(mode)); events.get("session_start")!(null, ctx(mode));
 }
 assert.equal(menus, 0); assert.equal(starts, 0); assert.equal(notes.length, 3); assert.ok(notes.every(n => /interactive terminal/.test(n)));
 await commands.get("gentle:herdr")!.handler("", ctx("tui")); assert.equal(menus, 1);
 events.get("session_start")!(null, ctx("tui")); assert.equal(starts, 1);
 events.get("session_shutdown")!(null, ctx("tui")); events.get("session_shutdown")!(null, ctx("tui")); assert.equal(stops, 1);
 const children: string[] = [];
 gentleHerdr({ registerCommand() {}, on: (name: string) => children.push(name) } as unknown as ExtensionAPI, { GENTLE_PI_AGENTS_CHILD: "1" });
 assert.deepEqual(children, []);
});
