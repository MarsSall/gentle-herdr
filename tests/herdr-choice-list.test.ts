import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createHerdrChoiceList } from "../lib/herdr-choice-list.ts";

test("current marker, movement updates preview only, Enter chooses, Esc cancels", () => {
 const results: (number | undefined)[] = [], previews: number[] = [];
 let renders = 0;
 const list = createHerdrChoiceList({ title: "Theme", options: ["Default", "nord", "dracula"], current: 1,
  preview: index => { previews.push(index); return [`preview ${index}`]; },
  keybindings: { matches: (data, key) => data === key }, requestRender: () => { renders++; }, done: value => results.push(value) });
 assert.match(list.render(80).join("\n"), /> nord \(current\)/);
 list.handleInput("tui.select.down");
 assert.match(list.render(80).join("\n"), /preview 2/);
 assert.deepEqual(results, []);
 list.handleInput("tui.select.up");
 list.handleInput("tui.select.confirm");
 assert.deepEqual(results, [1]);
 list.handleInput("tui.select.cancel");
 assert.deepEqual(results, [1, undefined]);
 assert.equal(renders, 2);
 assert.deepEqual(previews, [1, 2]);
});
test("every rendered line is width bounded including ANSI, wide glyphs and multiline title", () => {
 const list = createHerdrChoiceList({ title: "Theme\nremote warning", options: ["界".repeat(30)], current: 0,
  preview: () => ["\x1b[38;2;18;52;86m" + "界".repeat(60) + "\x1b[0m"],
  keybindings: { matches: () => false }, requestRender: () => {}, done: () => {} });
 for (const width of [0, 1, 2, 7, 40]) for (const line of list.render(width)) assert.ok(visibleWidth(line) <= width);
});
