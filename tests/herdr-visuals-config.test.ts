import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { planHerdrVisualsConfig as plan, type HerdrVisualsProjection } from "../lib/herdr-visuals-config.ts";
import { planHerdrTaskSummaryConfig as summaryPlan } from "../lib/herdr-task-summary-config.ts";
import { HERDR_NATIVE_THEMES } from "../lib/herdr-native-themes.ts";
import { projectHerdrTheme } from "../lib/herdr-theme-projection.ts";
import { parseColor } from "@earendil-works/pi-tui";
const tokens = ["sidebar_bg", "panel_bg", "active_row_bg", "selection_bg", "accent", "text", "red", "green"];
const projection: HerdrVisualsProjection = {
	theme: { name: "catppuccin", custom: Object.fromEntries(tokens.map(key => [key, "#123456"])) as any },
	taskSummaryStyle: { fg: "#abc", dim: true, bold: false },
};
const native = { ...projection, theme: { name: "nord" as const } };
function parse(text: string): any {
	const result = spawnSync("python3", ["-c", "import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: text, encoding: "utf8", timeout: 5000 });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}
function accepted(text: string, value = projection, action: "apply" | "remove" = "apply") {
	parse(text);
	const result = plan(text, value, action);
	assert.equal(result.ok, true, JSON.stringify(result));
	parse(result.text);
	return result;
}
function rejected(text: string, value = projection, action: "apply" | "remove" = "apply") {
	const snapshot = JSON.stringify(value);
	const result = plan(text, value, action);
	assert.equal(result.ok, false, text);
	assert.equal("text" in result, false);
	assert.equal(JSON.stringify(value), snapshot);
}
function rejectedBoth(text: string, value = projection) {
	rejected(text, value);
	rejected(text, value, "remove");
}

test("apply always creates both styled rows; removal restores all owned insertions", () => {
	const original = '# keep\n[theme]\n# base\n[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"]]\n';
	const on = accepted(original);
	assert.deepEqual(parse(on.text).ui.sidebar.agents.rows_by_agent.pi.slice(2), ["$summary", "$summary2"].map(token => [{ token, ...projection.taskSummaryStyle }]));
	assert.deepEqual(plan(on.text, projection), { ok: true, text: on.text, changed: false });
	const updated = accepted(on.text, { ...projection, taskSummaryStyle: { fg: "#FFF", dim: false, bold: true } });
	assert.ok(updated.text.includes('fg = "#FFF", dim = false, bold = true'));
	assert.deepEqual(plan(updated.text, projection, "remove"), { ok: true, text: original, changed: true });
	assert.deepEqual(plan(original, projection, "remove"), { ok: true, text: original, changed: false });
});

for (const original of ["", "# tail", "# tail\r\n", "[theme]", " [theme]\n", "\t[theme] \t# base\n", " \t[theme.custom] # empty\n", '[ui.sidebar.agents.rows_by_agent]\r\nclaude = [["agent"]]', '# first\r\n [theme] # base\r\n\t[theme.custom] # colors\r\n \t[ui.sidebar.agents.rows_by_agent] # rows\r\nclaude = [["agent"]]\r\n \t[other] # boundary\r\nx = 42']) {
	test(`comments, indentation, order, EOL and missing final newline round trip: ${JSON.stringify(original)}`, () => {
		for (const value of [projection, native]) {
			const on = accepted(original, value);
			assert.deepEqual(plan(on.text, value), { ok: true, text: on.text, changed: false });
			assert.equal(accepted(on.text, value, "remove").text, original);
			assert.equal(accepted(accepted(on.text, value, "remove").text, value).text, on.text);
		}
	});
}

test("removal never rewrites adopted user name, custom palette or summary styles", () => {
	const source = '# keep\r\n[theme]\r\nname = "one-dark" # mine\r\n[theme.custom]\r\ntext = "reset"\r\n[ui.sidebar.agents.rows_by_agent]\r\npi = [["$summary", "$summary2"]] # layout\r\n';
	assert.deepEqual(plan(source, native, "remove"), { ok: true, text: source, changed: false });
	const on = accepted(source, native);
	const off = accepted(on.text, native, "remove");
	// Recognized fields were adopted in place, not backed up. Removal only strips stamps.
	assert.equal(off.text, on.text);
	assert.ok(off.text.includes('name = "nord" # mine\r\n'));
	assert.ok(off.text.includes('text = "reset"\r\n'));
});

test("lexical guards reject surrogate escapes and raw DEL; scalar boundaries remain supported", () => {
	for (const source of ['x = "\\uD800"\n', 'x = "a\x7fb"\n', '#\x00\n', ...['\\uD800', '\\uDBFF', '\\uDC00', '\\uDFFF'].map(escape => `x = ["${escape}"]\n`)]) {
		const parsed = spawnSync("python3", ["-c", "import sys,tomllib; tomllib.loads(sys.stdin.read())"], { input: source, encoding: "utf8", timeout: 5000 });
		assert.equal(parsed.status, 1);
		rejectedBoth(source);
	}
	const source = String.raw`x = ["\uD7FF", "\uE000", "\uFFFF", "\u0000", "\u007F", "\b\f\n\r\t", "\"", "\\uD800", "#"]`;
	for (const original of [source + '\ny = [true, false, 12]\n# literal \\uD800 and "quoted" comment\ttext\n', '# literal \\uD800\r\n\t[other] # keep\r\n' + source]) {
		const on = accepted(original, native);
		assert.ok(on.text.includes(original));
		assert.equal(accepted(on.text, native, "remove").text, original);
	}
});

test("adopts recognized theme.name but never user custom values or surrounding bytes", () => {
	const source = '# keep\r\n[theme] # chosen\r\n  name  = "nord" # name\r\n[theme.custom]\r\ntext = "#fff" # foreground\r\nunknown = "#112233" # user token\r\n[other]\r\nx = 42';
	const on = accepted(source);
	assert.ok(on.text.includes('  name  = "catppuccin" # name\r\n'));
	assert.ok(on.text.includes('text = "#fff" # foreground\r\nunknown = "#112233" # user token\r\n'));
	assert.equal(accepted(on.text, projection, "remove").text, source.replace('"nord"', '"catppuccin"'));
	assert.deepEqual(plan(on.text, projection), { ok: true, text: on.text, changed: false });
});

test("adopts only summary styles in single-line and multiline user rows", () => {
	for (const eol of ["\n", "\r\n"]) {
		const before = '# keep\n[theme]\nname = "one-dark"\n[theme.custom]\npanel_bg = "#000000"\n[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"]] # other agent\n'.replaceAll("\n", eol);
		const after = '[other]\nx = 42'.replaceAll("\n", eol);
		for (const rows of [
			'  pi = [["state_icon", { token = "agent", fg = "#456", bold = true }], ["$summary"], [{ token = "$summary2", fg = "#fff", dim = false }, "workspace"]] # "$summary" stays a comment\n',
			'  pi = [ # layout [brackets] stay comments\n    ["state_icon", { token = "agent", fg = "#456", bold = true }],\n    ["$summary"], # summary row\n    [{ token = "$summary2", fg = "#fff", dim = false }, "workspace",],\n  ] # tail\n',
		].map(row => row.replaceAll("\n", eol))) {
			const value = { ...native, theme: { name: "one-dark" as const } };
			const on = accepted(before + rows + after, value);
			const expectedRows = rows.replace('"$summary"', '{ token = "$summary", fg = "#abc", dim = true, bold = false }').replace('fg = "#fff", dim = false', 'fg = "#abc", dim = true, bold = false');
			assert.equal(on.text, before + expectedRows + after);
			assert.deepEqual(plan(on.text, value), { ok: true, text: on.text, changed: false });
			assert.equal(accepted(on.text, value, "remove").text, on.text);
			assert.equal(accepted(before + rows + after, value, "remove").text, before + rows + after);
			for (const bad of [rows.replace('"$summary2"', '"$summary"'), rows.replace('dim = false', 'italic = true'), rows.replace(eol, '\r')]) rejectedBoth(before + bad + after, value);
		}
	}
});

test("mixed LF/CRLF adoption preserves every original line ending", () => {
	for (const [a, b] of [["\n", "\r\n"], ["\r\n", "\n"]]) {
		const source = '# keep' + a + '[theme]' + b + 'name = "one-dark" # base' + a
			+ '[theme.custom]' + b + 'text = "#fff" # palette' + a + '[ui.toast]' + b + 'enabled = true' + a
			+ '[ui.sidebar.agents.rows_by_agent]' + b + 'pi = [' + a + '  ["agent"], # keep rows' + b
			+ '  ["$summary"],' + a + '  ["$summary2"],' + b + ']' + a + '[other]' + b + 'x = 42';
		const expected = source.replace('name = "one-dark"', 'name = "nord"').replace('"$summary"', '{ token = "$summary", fg = "#abc", dim = true, bold = false }').replace('"$summary2"', '{ token = "$summary2", fg = "#abc", dim = true, bold = false }');
		assert.equal(accepted(source, native).text, expected);
		assert.equal(accepted(source, native, "remove").text, source);
		rejectedBoth(source.replace(a, "\r"), native);
	}
});

test("mixed unowned lines retain intact stamp EOL on update and removal", () => {
	for (const eol of ["\n", "\r\n"]) {
		const other = eol === "\n" ? "\r\n" : "\n";
		const source = '# keep' + eol + '[other]' + eol + 'x = 42';
		const mixed = accepted(source).text.replace('# keep' + eol, '# keep' + other);
		assert.deepEqual(plan(mixed, projection), { ok: true, text: mixed, changed: false });
		assert.equal(accepted(mixed, projection, "remove").text, source.replace('# keep' + eol, '# keep' + other));
		rejectedBoth(mixed.replace('#123456', '#654321'));
	}
	const source = '# head\n[other]\r\nx = 42';
	assert.equal(accepted(accepted(source).text, projection, "remove").text, source);
});

test("intact historical summary stamps upgrade or remove without preferences", () => {
	const source = '[theme]\nname = "nord" # retain\n';
	const old = summaryPlan(source, { summaryColor: "#123", continuationColor: "#456" });
	assert.equal(old.ok, true);
	const upgraded = accepted(old.text);
	assert.ok(upgraded.text.includes('name = "catppuccin" # retain\n'));
	assert.equal(upgraded.text.includes('task summary begin v1'), false);
	assert.deepEqual(plan(upgraded.text, projection), { ok: true, text: upgraded.text, changed: false });
	assert.equal(accepted(old.text, projection, "remove").text, source);
	for (const bad of [old.text + old.text, old.text.replace('#123', '#fff')]) rejectedBoth(bad);
});

test("ambiguous TOML, adoption, prospective ancestors and unowned layers fail closed", () => {
	for (const text of [
		'ui = true\n', '[ui]\nsidebar = []\n', '[ui.sidebar]\nagents = []\n', 'theme = []\n', '[theme]\ncustom = []\n',
		'[theme.custom.light]\n', '[theme.custom.dark]\n', '[theme]\nauto_switch = false\n', '[theme]\ndark_name = "nord"\n', '[theme]\nlight_name = "nord"\n',
		'[theme]\n[theme]\n', '[theme.custom]\n[theme.custom]\n', 'theme.name = "nord"\n', '["theme"]\n', 'x = { a = 1 }\n',
		'[theme]\nname = "unknown"\n', '[theme]\nname = "nord"\nname = "nord"\n', '[theme.custom]\ntext = "#fff"\ntext = "#fff"\n',
		'[ui.sidebar.agents]\nrows = []\n', '[ui.sidebar.agents.rows_by_agent]\npi = []\n',
		'[ui.sidebar.agents.rows_by_agent]\npi = [["$summary"]]\n', '[ui.sidebar.agents.rows_by_agent]\npi = [["$summary", "$summary", "$summary2"]]\n',
		'[ui.sidebar.agents.rows_by_agent]\npi = [[{ token = "$summary", fg = "#fff", fg = "#fff" }, "$summary2"]]\n',
		'[ui.sidebar.agents.rows_by_agent]\npi = [[{ token = "$summary", italic = true }, "$summary2"]]\n',
		'[ui.sidebar.agents.rows_by_agent]\npi = [["$summary", "$summary2"]]\npi = [["$summary", "$summary2"]]\n',
		'[ui.sidebar.agents]\nrows = []\n[ui.sidebar.agents.rows_by_agent]\npi = [["$summary", "$summary2"]]\n',
		'[ui.sidebar.agents.rows_by_agent]\npi = [\n ["$summary", "$summary2"]\n # missing closing bracket\n',
		'[ui.sidebar.agents.rows_by_agent]\npi = [["$summary", "$summary2"]] junk\n',
	]) rejectedBoth(text);
});

test("strict runtime projection rejects unknown keys, visibility, IDs, colors and non-booleans", () => {
	for (const value of [null, {}, { ...projection, extra: true }, { ...projection, enabled: true },
		{ ...projection, theme: { name: "unknown" } }, { ...projection, theme: { name: "nord", extra: true } },
		{ ...projection, theme: { name: "nord", custom: projection.theme.custom } },
		{ ...projection, theme: { name: "catppuccin", custom: { text: "#fff" } } },
		{ ...projection, taskSummaryStyle: { fg: "red", dim: true, bold: false } },
		{ ...projection, taskSummaryStyle: { ...projection.taskSummaryStyle, dim: "true" } },
		{ ...projection, taskSummaryStyle: { ...projection.taskSummaryStyle, bold: 0 } },
		{ ...projection, taskSummaryStyle: { ...projection.taskSummaryStyle, extra: true } },
	]) rejected("", value as any);
	for (const fg of ['#fff\n', 'accent', '#12', '#1234', '#ggg']) rejected('', { ...projection, taskSummaryStyle: { ...projection.taskSummaryStyle, fg } });
	for (const text of ['#fff', '#gggggg', '#12345678', 'accent', '#123456\n']) rejected('', { ...projection, theme: { name: 'catppuccin', custom: { ...projection.theme.custom!, text } } });
});

test("tampered, duplicated, relocated and mixed ownership fail on apply and removal", () => {
	const owned = accepted("").text;
	for (const bad of [owned + owned, owned.replace('#123456', '#654321'), owned.replace('name = "catppuccin"', 'name = "nord"'), owned.replace('dim = true', 'dim = false'), owned.replace('join=0', 'join=1'), owned + '# trailing\n', owned.replace('end v2', 'end v3'), '[theme]\nname = "nord"\n' + owned]) rejectedBoth(bad);
});

test("all documented native IDs plan name-only themes and both summary rows", () => {
	for (const name of HERDR_NATIVE_THEMES) {
		const value = { ...projection, theme: { name } };
		const on = accepted('# retained without newline', value);
		assert.deepEqual(parse(on.text).theme, { name });
		assert.equal(parse(on.text).ui.sidebar.agents.rows_by_agent.pi.length, 4);
		assert.deepEqual(plan(on.text, value), { ok: true, text: on.text, changed: false });
	}
});

const palette = Object.fromEntries(["accent", "text", "error", "success", "muted", "thinkingText", "borderAccent"].map(role => [role, parseColor("#d01199")]));
const defaultProjection = { ...projection, theme: projectHerdrTheme({ colors: palette } as any, "default") };
const cuteProjection = { ...projection, theme: projectHerdrTheme({ name: "Gentleman-Cute", colors: palette } as any, "default") };
const foregroundKeys = ["accent", "green", "mauve", "overlay0", "overlay1", "red", "subtext0", "text"];

test("Default leaves unconfigured backgrounds and status colors native", () => {
	const on = accepted('# keep\n[other]\nx = 42\n', defaultProjection);
	assert.deepEqual(Object.keys(parse(on.text).theme.custom).sort(), foregroundKeys);
	assert.equal(parse(on.text).theme.name, "one-dark");
	assert.deepEqual(plan(on.text, defaultProjection), { ok: true, text: on.text, changed: false });
});

for (const eol of ["\n", "\r\n", "mixed"]) test(`historical eight/twelve-color stamps retire owned colors only (${JSON.stringify(eol)})`, () => {
	const separator = eol === "mixed" ? "\r\n" : eol;
	let source = '# keep\n[theme]\nname = "nord"\n[theme.custom]\nblue = "#aabbcc" # mine\n[other]\nx = 42\n'.replaceAll("\n", separator);
	if (eol === "mixed") source = source.replace('# keep\r\n', '# keep\n');
	const twelve = { ...defaultProjection, theme: { name: "catppuccin" as const, custom: { ...defaultProjection.theme.custom!, yellow: "#111111", peach: "#222222", blue: "#333333", teal: "#444444" } } };
	for (const historical of [projection, twelve]) {
		const old = accepted(source, historical);
		const current = accepted(old.text, defaultProjection);
		assert.deepEqual(Object.keys(parse(current.text).theme.custom).sort(), ["blue", ...foregroundKeys].sort());
		assert.equal(parse(current.text).theme.custom.blue, "#aabbcc");
		assert.deepEqual(plan(current.text, defaultProjection), { ok: true, text: current.text, changed: false });
		const switched = accepted(current.text, { ...native, theme: { name: "dracula" } });
		const removed = accepted(switched.text, native, "remove");
		assert.equal(removed.text, source.replace('name = "nord"', 'name = "dracula"'));
		rejectedBoth(old.text.replace(historical === projection ? 'sidebar_bg = "#123456"' : 'teal = "#444444"', 'text = "#654321"'), defaultProjection);
	}
});

for (const eol of ["\n", "\r\n"]) test(`Default respects complete, partial, named and reset user palettes (${JSON.stringify(eol)})`, () => {
	for (const body of [
		'sidebar_bg = "#010203" # keep\npanel_bg = "#112233"\nactive_row_bg = "#223344"\nselection_bg = "#334455"\naccent = "#abc" # mine\n',
		'panel_bg = "#000000"\nsurface0 = "#241822"\ntext = "#F6EFF3"\naccent = "#F095C8"\ngreen = "#B4E7C7"\nred = "#FF718F"\n',
		'panel_bg = "reset" # terminal background\naccent = "default"\ntext = "red"\nsidebar_bg = "none"\noverlay0 = "reset" # mine\nblue = "blue"\n',
	]) {
		const user = body.replaceAll("\n", eol);
		const source = '[theme]\nname = "one-dark"\n[theme.custom]\n'.replaceAll("\n", eol) + user;
		for (const value of [projection, defaultProjection, cuteProjection, native]) {
			const on = accepted(source, value);
			assert.ok(on.text.includes(user));
			for (const [key, color] of Object.entries(parse(source).theme.custom)) assert.equal(parse(on.text).theme.custom[key], color);
			assert.deepEqual(plan(on.text, value), { ok: true, text: on.text, changed: false });
			assert.equal(accepted(on.text, value, "remove").text, source.replace('name = "one-dark"', `name = "${value.theme.name}"`));
		}
	}
	const source = '[theme]\nname = "catppuccin"\n[theme.custom]\npanel_bg = "#000000" # mine\nsurface1 = "reset"\n[ui]\nx = 1\n'.replaceAll("\n", eol);
	const on = accepted(source, cuteProjection);
	const theme = parse(on.text).theme;
	assert.deepEqual([theme.custom.surface0, theme.custom.surface_dim, theme.custom.overlay0], ["#241822", "#20161E", "#B99AA9"]);
	assert.equal(theme.custom.surface1, "reset");
	assert.ok(on.text.includes('panel_bg = "#000000" # mine' + eol + 'surface1 = "reset"' + eol));
	assert.deepEqual(parse(accepted(on.text, native).text).theme, { name: "nord", custom: { panel_bg: "#000000", surface1: "reset" } });
	for (const bad of ['panel_bg = reset', 'panel_bg = "reset"\npanel_bg = "reset"', 'text = "re\\"d"']) rejectedBoth('[theme.custom]\n' + bad + '\n', cuteProjection);
});

test("neutral Gentle Default adds only its Dots panel background", () => {
	const neutral = { ...projection, theme: projectHerdrTheme({ name: "Gentle", colors: palette } as any, "default") };
	const custom = parse(accepted('[other]\nx = 42\n', neutral).text).theme.custom;
	assert.equal(custom.panel_bg, "#06080f");
	assert.equal("surface0" in custom, false);
	rejected('', { ...neutral, theme: { ...neutral.theme, custom: { ...neutral.theme.custom!, surface0: "#123456" } } });
});
