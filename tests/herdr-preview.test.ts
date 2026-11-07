import assert from "node:assert/strict";
import test from "node:test";
import { parseColor } from "@earendil-works/pi-tui";
import { buildHerdrPreview } from "../lib/herdr-preview.ts";

const theme = { name: "Gentleman-Cute", colors: Object.fromEntries(
 ["accent", "text", "muted", "dim", "success", "warning", "error", "thinkingText", "borderAccent"].map((key, i) => [key, parseColor(["#123456", "#234567", "#345678", "#456789", "#56789a", "#6789ab", "#789abc", "#89abcd", "#9abcde"][i]!)])) };
const settings = { theme: "default", summaryColor: "warning" } as const;
test("Default sidebar uses live projection, secondary text, saved summary style and panel", () => {
 const lines = buildHerdrPreview(theme as never, settings, "theme", "default");
 assert.deepEqual(lines.slice(0, 4), [
  "\x1b[48;2;0;0;0m\x1b[38;2;18;52;86mpi\x1b[0m",
  "\x1b[48;2;0;0;0m\x1b[38;2;52;86;120m  Secondary text\x1b[0m",
  "\x1b[48;2;0;0;0m\x1b[38;2;103;137;171m◐ Continue the same task title\x1b[0m",
  "\x1b[48;2;0;0;0m\x1b[38;2;103;137;171m  and its second row\x1b[0m",
 ]);
});
test("native themes describe Herdr's own theme without inventing colors", () => {
 assert.deepEqual(buildHerdrPreview({} as never, settings, "theme", "nord"), ["Looks like Herdr's built-in nord theme (colors come from Herdr)"]);
});
test("summary previews use saved Default background and selected color on both rows", () => {
 const lines = buildHerdrPreview(theme as never, settings, "summaryColor", "default");
 assert.equal(lines.length, 2);
 for (const line of lines) assert.match(line, /\x1b\[48;2;0;0;0m\x1b\[38;2;18;52;86m\x1b\[2m/);
 const native = buildHerdrPreview(theme as never, { ...settings, theme: "nord" }, "summaryColor", "success");
 assert.doesNotMatch(native.join("\n"), /48;2/);
 assert.match(native[0]!, /\x1b\[38;2;86;120;154m/);
 assert.match(native[1]!, /\x1b\[38;2;86;120;154m/);
 assert.match(native[2]!, /terminal default background/i);
});
