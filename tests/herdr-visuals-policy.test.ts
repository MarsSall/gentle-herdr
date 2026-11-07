import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { HERDR_NATIVE_THEMES } from "../lib/herdr-native-themes.ts";
import { DEFAULT_HERDR_VISUALS_SETTINGS, HERDR_SUMMARY_COLORS, HERDR_VISUALS_SCHEMA,
	isHerdrVisualsSettings, resolveHerdrVisualsSettings, writeHerdrVisualsSettings,
	type HerdrVisualsSettings } from "../lib/herdr-visuals-policy.ts";

test("v1 stores migrate to v2 with same-as-client machines; machine choices are strict", () => {
 const { options, file } = fixture();
 writeFileSync(file, JSON.stringify({ schema: "gentle-herdr.preferences/v1", theme: "nord", summaryColor: "default" }));
 const resolved = resolveHerdrVisualsSettings(options);
 assert.equal(resolved.malformed, false);
 assert.deepEqual(resolved.settings.machines, {});
 const settings = { ...resolved.settings, machines: { office: { theme: "same" as const }, lab: { theme: "default" as const } } };
 writeHerdrVisualsSettings(settings, options);
 assert.equal(JSON.parse(readFileSync(file, "utf8")).schema, "gentle-herdr.preferences/v2");
 assert.deepEqual(resolveHerdrVisualsSettings(options).settings, settings);
 for (const machines of [[], null, { a: { theme: "unknown" } }, { a: { theme: "same", extra: true } }]) {
  assert.equal(isHerdrVisualsSettings({ theme: "default", summaryColor: "default", machines }), false);
 }
});

function fixture() {
	const root = resolve("tests/.fixtures/visuals-policy");
	mkdirSync(root, { recursive: true });
	const home = mkdtempSync(join(root, "case-"));
	return { home, options: { agentDir: home }, file: join(home, "gentle-herdr.json") };
}
function record(settings = DEFAULT_HERDR_VISUALS_SETTINGS) {
	return JSON.stringify({ schema: HERDR_VISUALS_SCHEMA, ...settings });
}

test("oversized machine preference maps refuse writing an unreadable store", () => {
 const { options, home } = fixture();
 const machines = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`machine-${i}`, { theme: "same" as const }]));
 assert.throws(() => writeHerdrVisualsSettings({ theme: "default", summaryColor: "default", machines }, options), /[Oo]versized/);
 assert.deepEqual(readdirSync(home), []);
});

test("missing package preferences default without bootstrap; exact package path and schema", () => {
	const { options, file, home } = fixture();
	assert.equal(HERDR_VISUALS_SCHEMA, "gentle-herdr.preferences/v2");
	assert.deepEqual(resolveHerdrVisualsSettings(options), {
		settings: { theme: "default", summaryColor: "default", machines: {} }, globalFile: file, source: "default",
		malformed: false, readError: false,
	});
	resolveHerdrVisualsSettings(options).settings.summaryColor = "error";
	assert.deepEqual(resolveHerdrVisualsSettings(options).settings, DEFAULT_HERDR_VISUALS_SETTINGS);
	assert.deepEqual(readdirSync(home), []);
});

test("strict settings accept only native/default themes and semantic/default colors", () => {
	for (const theme of ["default", ...HERDR_NATIVE_THEMES]) {
		for (const summaryColor of ["default", ...HERDR_SUMMARY_COLORS]) {
			assert.equal(isHerdrVisualsSettings({ theme, summaryColor }), true);
		}
	}
	for (const value of [null, [], {}, { theme: "default" }, { summaryColor: "default" },
		{ theme: "catppuccin-latte", summaryColor: "default" }, { theme: 1, summaryColor: "accent" },
		{ theme: "default", summaryColor: "#ffffff" }, { ...DEFAULT_HERDR_VISUALS_SETTINGS, enabled: true },
		{ theme: "default", taskSummaryColor: "default" }]) {
		assert.equal(isHerdrVisualsSettings(value), false);
	}
});

test("Gentle Shell stores are never opened, used as fallback, or modified", t => {
	const { options, home, file } = fixture();
	for (const name of ["herdr-task-summary.json", "herdr-visuals.json"]) writeFileSync(join(home, name), "{");
	const open = fs.openSync;
	const opened: unknown[] = [];
	t.mock.method(fs, "openSync", (...args: unknown[]) => {
		opened.push(args[0]);
		return Reflect.apply(open, fs, args);
	});
	syncBuiltinESMExports();
	try {
		assert.equal(resolveHerdrVisualsSettings(options).source, "default");
		writeHerdrVisualsSettings({ theme: "nord", summaryColor: "warning" }, options);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.ok(opened.length > 0);
	assert.ok(opened.every(path => String(path) === file || String(path).startsWith(file + ".")));
	for (const name of ["herdr-task-summary.json", "herdr-visuals.json"]) assert.equal(readFileSync(join(home, name), "utf8"), "{");
});

test("all supported choices write a strict private atomic package record", () => {
	const { options, file, home } = fixture();
	for (const theme of ["default", ...HERDR_NATIVE_THEMES] as const) {
		for (const summaryColor of ["default", ...HERDR_SUMMARY_COLORS] as const) {
			const settings = { theme, summaryColor };
			assert.equal(writeHerdrVisualsSettings(settings, options), file);
			assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schema: "gentle-herdr.preferences/v2", ...settings, machines: {} });
			assert.deepEqual(resolveHerdrVisualsSettings(options).settings, { ...settings, machines: {} });
			assert.equal(statSync(file).mode & 0o777, 0o600);
			assert.equal(statSync(file).nlink, 1);
			assert.deepEqual(readdirSync(home), ["gentle-herdr.json"]);
		}
	}
});

test("malformed package store refuses replacement and preserves every byte", () => {
	const { options, file, home } = fixture();
	for (const raw of ["{", "null", "[]", "{}", record({ theme: "unknown", summaryColor: "dim" } as unknown as HerdrVisualsSettings),
		JSON.stringify({ schema: "wrong", ...DEFAULT_HERDR_VISUALS_SETTINGS }),
		JSON.stringify({ schema: HERDR_VISUALS_SCHEMA, ...DEFAULT_HERDR_VISUALS_SETTINGS, extra: true }),
		JSON.stringify({ schema: "gentle-pi.herdr-visuals/v1", theme: "default", taskSummaryColor: "default" })]) {
		writeFileSync(file, raw);
		const result = resolveHerdrVisualsSettings(options);
		assert.equal(result.malformed, true);
		assert.equal(result.source, "global_file");
		assert.deepEqual(result.settings, DEFAULT_HERDR_VISUALS_SETTINGS);
		assert.throws(() => writeHerdrVisualsSettings(DEFAULT_HERDR_VISUALS_SETTINGS, options), /Refusing/);
		assert.equal(readFileSync(file, "utf8"), raw);
		assert.deepEqual(readdirSync(home), ["gentle-herdr.json"]);
	}
});

test("nonregular and oversized package stores report read errors without overwrite", () => {
	for (const directory of [true, false]) {
		const { options, file, home } = fixture();
		if (directory) mkdirSync(file); else writeFileSync(file, " ".repeat(4097));
		assert.equal(resolveHerdrVisualsSettings(options).readError, true);
		assert.throws(() => writeHerdrVisualsSettings(DEFAULT_HERDR_VISUALS_SETTINGS, options), /Refusing/);
		assert.equal(statSync(file).isDirectory(), directory);
		if (!directory) assert.equal(readFileSync(file, "utf8"), " ".repeat(4097));
		assert.deepEqual(readdirSync(home), ["gentle-herdr.json"]);
	}
});

test("permission errors refuse writing rather than treating the store as absent", t => {
	const { options, file } = fixture();
	const failure = Object.assign(new Error("controlled read failure"), { code: "EACCES" });
	t.mock.method(fs, "openSync", () => { throw failure; });
	syncBuiltinESMExports();
	try {
		assert.equal(resolveHerdrVisualsSettings(options).readError, true);
		assert.throws(() => writeHerdrVisualsSettings(DEFAULT_HERDR_VISUALS_SETTINGS, options), /Refusing/);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.equal(fs.existsSync(file), false);
});

test("request validation precedes store inspection and has no effects", () => {
	const { options, file, home } = fixture();
	writeFileSync(file, "{");
	for (const invalid of [null, {}, { ...DEFAULT_HERDR_VISUALS_SETTINGS, summaryColor: "blue" },
		{ ...DEFAULT_HERDR_VISUALS_SETTINGS, continuationColor: "dim" }]) {
		assert.throws(() => writeHerdrVisualsSettings(invalid as HerdrVisualsSettings, options), TypeError);
		assert.equal(readFileSync(file, "utf8"), "{");
		assert.deepEqual(readdirSync(home), ["gentle-herdr.json"]);
	}
});

for (const step of ["writeFileSync", "renameSync"] as const) test(`a failed ${step} removes the temporary file and keeps the previous store`, t => {
	const { options, file, home } = fixture();
	writeHerdrVisualsSettings({ ...DEFAULT_HERDR_VISUALS_SETTINGS, theme: "nord" }, options);
	const before = readFileSync(file, "utf8");
	const original = fs[step];
	const failure = Object.assign(new Error(`controlled ${step} failure`), { code: "ENOSPC" });
	t.mock.method(fs, step, (...args: unknown[]) => {
		if (step === "writeFileSync") Reflect.apply(original, fs, [args[0], "", { flag: "wx", mode: 0o600 }]);
		throw failure;
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeHerdrVisualsSettings(DEFAULT_HERDR_VISUALS_SETTINGS, options), failure);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.deepEqual(readdirSync(home).filter(name => name.endsWith(".tmp")), []);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.equal(resolveHerdrVisualsSettings(options).settings.theme, "nord");
});

test("exclusive-temp collision never removes a file the writer did not create", t => {
	const { options, home } = fixture();
	const original = fs.writeFileSync;
	let collision = "";
	const failure = Object.assign(new Error("controlled exclusive-temp collision"), { code: "EEXIST" });
	t.mock.method(fs, "writeFileSync", (...args: unknown[]) => {
		collision = String(args[0]);
		assert.deepEqual(args[2], { flag: "wx", mode: 0o600 });
		Reflect.apply(original, fs, [args[0], "another writer", { flag: "wx", mode: 0o600 }]);
		throw failure;
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeHerdrVisualsSettings(DEFAULT_HERDR_VISUALS_SETTINGS, options), failure);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.ok(collision.startsWith(join(home, "gentle-herdr.json.")));
	assert.equal(readFileSync(collision, "utf8"), "another writer");
});

test("a failed cleanup never masks the original write failure", t => {
	const { options } = fixture();
	const original = fs.writeFileSync;
	const failure = Object.assign(new Error("controlled write failure"), { code: "ENOSPC" });
	t.mock.method(fs, "writeFileSync", (...args: unknown[]) => {
		Reflect.apply(original, fs, [args[0], "", { flag: "wx", mode: 0o600 }]);
		throw failure;
	});
	t.mock.method(fs, "rmSync", () => { throw Object.assign(new Error("controlled cleanup failure"), { code: "EACCES" }); });
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeHerdrVisualsSettings(DEFAULT_HERDR_VISUALS_SETTINGS, options), failure);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
