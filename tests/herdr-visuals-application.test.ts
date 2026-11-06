import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as application from "../lib/herdr-visuals-application.ts";
import { projectHerdrTaskSummaryStyle } from "../lib/herdr-theme-projection.ts";
import { parseColor } from "@earendil-works/pi-tui";
import { createHerdrVisualsApplication, localHerdrVisualsApplication } from "../lib/herdr-visuals-application.ts";
import { planHerdrVisualsConfig, type HerdrVisualsProjection } from "../lib/herdr-visuals-config.ts";

const projection: HerdrVisualsProjection = { theme: { name: "nord" }, taskSummaryStyle: { fg: "#abc123", dim: false, bold: false } };
function fixture(t: test.TestContext) {
	const home = fs.mkdtempSync(join(tmpdir(), "gentle-herdr-application-")), path = join(home, "config.toml");
	const plan = planHerdrVisualsConfig('# retained\n[server]\nport = 1234\n', { ...projection, theme: { name: "dracula" } });
	assert.ok(plan.ok); const before = plan.text;
	fs.writeFileSync(path, before, { mode: 0o640 });
	const reloads: string[] = [];
	const apply = createHerdrVisualsApplication({ configPath: path, reload: async () => { reloads.push(fs.readFileSync(path, "utf8")); } });
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	return { home, path, before, reloads, apply, bytes: () => fs.readFileSync(path, "utf8") };
}

test("service commits owned bytes before reload, preserves permissions, and is idempotent", async t => {
	const h = fixture(t), expected = planHerdrVisualsConfig(h.before, projection); assert.ok(expected.ok);
	assert.deepEqual(await h.apply(projection), { status: "requested" });
	assert.equal(h.bytes(), expected.text); assert.deepEqual(h.reloads, [expected.text]);
	assert.equal(fs.statSync(h.path).mode & 0o777, 0o640);
	const inode = fs.statSync(h.path).ino;
	assert.deepEqual(await h.apply(projection), { status: "unchanged" });
	assert.equal(fs.statSync(h.path).ino, inode); assert.deepEqual(h.reloads, [expected.text]);
});

for (const mixed of [false, true]) test(`service first-adopts native theme and multiline Pi rows without losing user settings (${mixed ? 'mixed LF/CRLF' : 'CRLF'})`, async t => {
	const h = fixture(t);
	const consistent = '[theme]\r\nname = "one-dark"\r\n[theme.custom]\r\npanel_bg = "#000000" # user palette\r\ntext = "#fff"\r\n[ui.sidebar.agents.rows_by_agent]\r\npi = [\r\n  ["agent", "workspace"], # layout\r\n  ["$summary"],\r\n  ["$summary2"],\r\n]\r\n[other]\r\nx = 42';
	const source = mixed ? consistent.replace('[theme]\r\n', '[theme]\n') : consistent;
	const styled = source.replace('name = "one-dark"', 'name = "nord"')
		.replace('"$summary"', '{ token = "$summary", fg = "#abc123", dim = false, bold = false }')
		.replace('"$summary2"', '{ token = "$summary2", fg = "#abc123", dim = false, bold = false }');
	fs.writeFileSync(h.path, source);
	assert.deepEqual(await h.apply(projection), { status: 'requested' });
	assert.equal(h.bytes(), styled);
	assert.deepEqual(h.reloads, [styled]);
	assert.equal(fs.statSync(h.path).mode & 0o777, 0o640);
	const inode = fs.statSync(h.path).ino;
	assert.deepEqual(await h.apply(projection), { status: 'unchanged' });
	assert.equal(fs.statSync(h.path).ino, inode);
	assert.deepEqual(h.reloads, [styled]);
	const invalid = source.replace('"$summary2"', '"$summary"');
	fs.writeFileSync(h.path, invalid);
	const before = fs.statSync(h.path);
	assert.deepEqual(await h.apply(projection), { status: 'partial', stage: 'config', error: 'Unsupported or ambiguous controlled fields; no changes proposed.' });
	assert.equal(h.bytes(), invalid);
	assert.equal(fs.statSync(h.path).ino, before.ino);
	assert.equal(fs.statSync(h.path).mode, before.mode);
	assert.deepEqual(h.reloads, [styled]);
});

for (const kind of ["symlink", "directory", "oversized", "hardlink"] as const) test(`service rejects ${kind} without writing or reloading`, async t => {
	const h = fixture(t); let path = join(h.home, kind);
	if (kind === "symlink") fs.symlinkSync(h.path, path);
	if (kind === "directory") fs.mkdirSync(path);
	if (kind === "oversized") fs.writeFileSync(path, "x".repeat(262145));
	if (kind === "hardlink") fs.linkSync(h.path, path);
	const apply = createHerdrVisualsApplication({ configPath: path, reload: async () => { h.reloads.push("unexpected"); } });
	assert.deepEqual(await apply(projection), { status: "partial", stage: "config", error: "Herdr config must be a bounded regular single-link file" });
	assert.equal(h.bytes(), h.before); assert.deepEqual(h.reloads, []);
	if (kind === "oversized") assert.equal(fs.readFileSync(path, "utf8"), "x".repeat(262145));
	if (kind === "directory") assert.deepEqual(fs.readdirSync(path), []);
});

test("relative and symlinked parent targets are rejected", async t => {
	const h = fixture(t), alias = join(h.home, "alias"); fs.symlinkSync(h.home, alias);
	for (const configPath of ["config.toml", join(alias, "config.toml")]) {
		assert.deepEqual(await createHerdrVisualsApplication({ configPath, reload: async () => assert.fail("reload") })(projection),
			{ status: "partial", stage: "config", error: "Unsupported or symlinked Herdr config path" });
	}
	assert.equal(h.bytes(), h.before); assert.deepEqual(h.reloads, []);
});

test("missing config is not bootstrapped", async t => {
	const h = fixture(t), path = join(h.home, "missing.toml");
	assert.deepEqual(await createHerdrVisualsApplication({ configPath: path, reload: async () => assert.fail("reload") })(projection),
		{ status: "partial", stage: "config", error: `ENOENT: no such file or directory, lstat '${path}'` });
	assert.equal(fs.existsSync(path), false); assert.equal(h.bytes(), h.before); assert.deepEqual(h.reloads, []);
});

for (const stage of ["read", "write", "rename"] as const) test(`controlled ${stage} failure leaves original config and no reload`, async t => {
	const h = fixture(t);
	const name = stage === "read" ? "openSync" : stage === "write" ? "writeFileSync" : "renameSync";
	t.mock.method(fs, name, () => { throw new Error(`controlled ${stage} failure`); }); syncBuiltinESMExports();
	assert.deepEqual(await h.apply(projection), { status: "partial", stage: "config", error: `controlled ${stage} failure` });
	assert.equal(h.bytes(), h.before); assert.deepEqual(h.reloads, []);
});

test("planner rejection and invalid UTF-8 do not overwrite original bytes", async t => {
	const h = fixture(t), broken = h.before.replace('name = "dracula"', 'name = "nord"');
	fs.writeFileSync(h.path, broken); const rejected = planHerdrVisualsConfig(broken, projection); assert.equal(rejected.ok, false);
	if (rejected.ok) assert.fail("expected rejection");
	assert.deepEqual(await h.apply(projection), { status: "partial", stage: "config", error: rejected.error });
	assert.equal(h.bytes(), broken); assert.deepEqual(h.reloads, []);
	const bytes = Buffer.from([0xff]); fs.writeFileSync(h.path, bytes);
	assert.deepEqual(await h.apply(projection), { status: "partial", stage: "config", error: "The encoded data was not valid for encoding utf-8" });
	assert.deepEqual(fs.readFileSync(h.path), bytes); assert.deepEqual(h.reloads, []);
});

for (const kind of ["bytes", "identity"] as const) test(`detected concurrent ${kind} change is not clobbered`, async t => {
	const h = fixture(t), original = fs.fsyncSync, external = `${h.before}# external\n`;
	t.mock.method(fs, "fsyncSync", (fd: number) => {
		original(fd);
		if (kind === "bytes") fs.writeFileSync(h.path, external);
		else { const replacement = join(h.home, "replacement"); fs.writeFileSync(replacement, external); fs.renameSync(replacement, h.path); }
	}); syncBuiltinESMExports();
	assert.deepEqual(await h.apply(projection), { status: "partial", stage: "config", error: "Herdr config changed before replacement" });
	assert.equal(h.bytes(), external); assert.deepEqual(h.reloads, []);
});

test("reload failure reports committed config and unknown client state, without retry", async t => {
	const h = fixture(t); let calls = 0;
	const apply = createHerdrVisualsApplication({ configPath: h.path, reload: async () => { calls++; throw new Error("controlled offline"); } });
	assert.deepEqual(await apply(projection), { status: "partial", stage: "reload", error: "controlled offline" });
	assert.notEqual(h.bytes(), h.before); assert.match(h.bytes(), /name = "nord"/); assert.equal(calls, 1);
	assert.deepEqual(await apply(projection), { status: "unchanged" }); assert.equal(calls, 1);
});

test("remove restores only owned insertions and reloads only once", async t => {
	const h = fixture(t);
	assert.deepEqual(await application.removeHerdrVisualsBlocks(h.apply), { status: "requested" });
	assert.equal(h.bytes(), '# retained\n[server]\nport = 1234\n');
	const inode = fs.statSync(h.path).ino;
	assert.deepEqual(await application.removeHerdrVisualsBlocks(h.apply), { status: "unchanged" });
	assert.equal(fs.statSync(h.path).ino, inode);
	assert.deepEqual(h.reloads, [h.bytes()]);
});

test("removal refuses ambiguous or tampered TOML without writing or reloading", async t => {
	const h = fixture(t);
	for (const broken of [h.before.replace('name = "dracula"', 'name = "nord"'), '[theme]\nname = "nord"\nname = "dracula"\n']) {
		fs.writeFileSync(h.path, broken);
		const inode = fs.statSync(h.path).ino;
		const result = await application.removeHerdrVisualsBlocks(h.apply);
		assert.equal(result.status, "partial");
		if (result.status === "partial") assert.equal(result.stage, "config");
		assert.equal(h.bytes(), broken);
		assert.equal(fs.statSync(h.path).ino, inode);
	}
	assert.deepEqual(h.reloads, []);
});

test("applying package preferences projects theme and summaryColor with both rows, without store access", async t => {
	const h = fixture(t);
	const palette = { colors: { accent: parseColor("#abcdef"), warning: parseColor("#fedcba") } } as Parameters<typeof projectHerdrTaskSummaryStyle>[0];
	assert.deepEqual(await application.applyHerdrVisualsPreferences({ theme: "nord", summaryColor: "warning" }, palette, h.apply), { status: "requested" });
	assert.match(h.bytes(), /name = "nord"/);
	assert.match(h.bytes(), /token = "\$summary", fg = "#fedcba"/);
	assert.match(h.bytes(), /token = "\$summary2", fg = "#fedcba"/);
	assert.deepEqual(await application.applyHerdrVisualsPreferences({ theme: "nord", summaryColor: "warning" }, palette, h.apply), { status: "unchanged" });
	assert.equal(h.reloads.length, 1);
});

const pane = { HERDR_ENV: "1", HERDR_PANE_ID: "fake", HERDR_SOCKET_PATH: "/owned-fake.sock" };

test("menu preflight and both actions refuse unsafe contexts before any config access", async t => {
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	for (const name of ["realpathSync", "lstatSync", "openSync", "readFileSync"] as const) {
		t.mock.method(fs, name, () => assert.fail("no config access"));
	}
	t.mock.method(childProcess, "execFile", () => assert.fail("no executable"));
	syncBuiltinESMExports();
	for (const platform of ["linux", "win32"] as const) {
		for (const extra of [{ SSH_CONNECTION: "remote" }, { SSH_CLIENT: "remote" }, { SSH_TTY: "remote" },
			{ GENTLE_PI_AGENTS_CHILD: "1" }, { HERDR_BIN_PATH: "herdr-dev" }, { HERDR_BIN_PATH: "HERDR-DEV.EXE" }]) {
			const env = { ...pane, ...extra,
				HERDR_SOCKET_PATH: platform === "win32" ? "C:\\Herdr\\socket" : pane.HERDR_SOCKET_PATH,
				HERDR_CONFIG_PATH: platform === "win32" ? "C:\\FakeAppData\\herdr\\config.toml" : "/never-read.toml" };
			const reason = "SSH_CONNECTION" in extra || "SSH_CLIENT" in extra || "SSH_TTY" in extra ? "remote" : "unavailable";
			assert.deepEqual(application.localHerdrVisualsAvailability(env, platform), { available: false, reason });
			const apply = localHerdrVisualsApplication(env, platform);
			assert.deepEqual(await apply(projection), { status: "unavailable", ...(reason === "remote" ? { reason } : {}) });
			assert.deepEqual(await application.removeHerdrVisualsBlocks(apply), { status: "unavailable", ...(reason === "remote" ? { reason } : {}) });
		}
	}
	assert.deepEqual(application.localHerdrVisualsAvailability({ ...pane, HERDR_CONFIG_PATH: "/fake/config.toml" }, "linux"), { available: true });
	assert.deepEqual(application.localHerdrVisualsAvailability({}, "linux"), { available: false, reason: "unavailable" });
	assert.deepEqual(application.localHerdrVisualsAvailability({ ...pane, HERDR_SOCKET_PATH: "C:\\Herdr\\socket", APPDATA: "C:\\FakeAppData" }, "win32"), { available: true });
});
test("unsupported, child, remote and ambiguous contexts do not access config or executable", async t => {
	t.mock.method(fs, "lstatSync", () => assert.fail("no config access"));
	t.mock.method(childProcess, "execFile", () => assert.fail("no executable")); syncBuiltinESMExports();
	for (const extra of [{ SSH_CONNECTION: "remote" }, { SSH_CLIENT: "remote" }, { SSH_TTY: "/dev/pts/1" }]) for (const platform of ["linux", "win32"] as const) {
		assert.deepEqual(await localHerdrVisualsApplication({ ...pane, ...extra }, platform)(projection), { status: "unavailable", reason: "remote" });
	}
	assert.deepEqual(await localHerdrVisualsApplication({ SSH_CONNECTION: "remote" }, "linux")(projection), { status: "unavailable" });
	for (const env of [{}, { ...pane, GENTLE_PI_AGENTS_CHILD: "1" },
		{ ...pane, HERDR_CONFIG_PATH: "relative" }, { ...pane, HERDR_CONFIG_PATH: " " }, { ...pane, HERDR_SOCKET_PATH: "relative" }]) {
		assert.deepEqual(await localHerdrVisualsApplication(env)(projection), { status: "unavailable" });
	}
	assert.deepEqual(await localHerdrVisualsApplication(pane, "win32")(projection), { status: "unavailable" });
	t.mock.restoreAll(); syncBuiltinESMExports();
});

for (const binary of ["/owned fake/herdr-dev", "herdr-dev"] as const) for (const source of ["xdg", "home", "override"] as const) test(`debug binary ${binary} with ${source} is unavailable before config I/O or reload`, async t => {
	const h = fixture(t), root = join(h.home, "root");
	const config = source === "override" ? h.path : join(root, source === "home" ? ".config/herdr" : "herdr", "config.toml");
	if (source !== "override") { fs.mkdirSync(join(config, ".."), { recursive: true }); fs.writeFileSync(config, h.before, { mode: 0o640 }); }
	const env = { ...pane, HERDR_BIN_PATH: binary, ...(source === "override" ? { HERDR_CONFIG_PATH: config }
		: source === "xdg" ? { XDG_CONFIG_HOME: root } : { HOME: root }) };
	const before = { bytes: fs.readFileSync(config, "utf8"), mode: fs.statSync(config).mode, inode: fs.statSync(config).ino,
		entries: fs.readdirSync(join(config, "..")).sort() };
	const io: string[] = []; let reloads = 0;
	for (const name of ["realpathSync", "lstatSync", "statSync", "existsSync", "accessSync", "openSync", "readSync", "readFileSync", "writeFileSync", "fchmodSync", "fsyncSync", "renameSync", "closeSync", "mkdirSync", "unlinkSync"] as const) {
		const original = fs[name];
		t.mock.method(fs, name, (...args: unknown[]) => { io.push(name); return Reflect.apply(original, fs, args); });
	}
	t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
		reloads++; (args[3] as (error: Error | null) => void)(null);
	}); syncBuiltinESMExports();
	const result = await localHerdrVisualsApplication(env, "linux")(projection);
	t.mock.restoreAll(); syncBuiltinESMExports();
	assert.deepEqual({ result, io, reloads, bytes: fs.readFileSync(config, "utf8"), mode: fs.statSync(config).mode,
		inode: fs.statSync(config).ino, entries: fs.readdirSync(join(config, "..")).sort() },
		{ result: { status: "unavailable" }, io: [], reloads: 0, ...before });
});

for (const source of ["override", "xdg", "home"] as const) test(`local ${source} resolution uses shell-free bounded supported reload`, async t => {
	const h = fixture(t);
	const root = join(h.home, "root"), config = source === "override" ? h.path : join(root, source === "home" ? ".config/herdr" : "herdr", "config.toml");
	if (source !== "override") { fs.mkdirSync(join(config, ".."), { recursive: true }); fs.writeFileSync(config, h.before); }
	const env = { ...pane, HERDR_BIN_PATH: "/owned fake/herdr", ...(source === "override" ? { HERDR_CONFIG_PATH: config }
		: source === "xdg" ? { XDG_CONFIG_HOME: root } : { HOME: root }) };
	let calls = 0;
	t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
		calls++; assert.equal(args[0], env.HERDR_BIN_PATH); assert.deepEqual(args[1], ["server", "reload-config"]);
		assert.deepEqual(args[2], { env, timeout: 1500, maxBuffer: 4096, windowsHide: true });
		assert.match(fs.readFileSync(config, "utf8"), /name = "nord"/);
		(args[3] as (error: Error | null) => void)(null);
	}); syncBuiltinESMExports();
	assert.deepEqual(await localHerdrVisualsApplication(env)(projection), { status: "requested" }); assert.equal(calls, 1);
});

test("local removal forwards the remove action and does not reload again when unchanged", async t => {
	const h = fixture(t);
	let calls = 0;
	t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
		calls++;
		assert.equal(args[0], "/fake/herdr");
		assert.deepEqual(args[1], ["server", "reload-config"]);
		assert.equal(h.bytes(), '# retained\n[server]\nport = 1234\n');
		(args[3] as (error: Error | null) => void)(null);
	});
	syncBuiltinESMExports();
	const apply = localHerdrVisualsApplication({ ...pane, HERDR_CONFIG_PATH: h.path, HERDR_BIN_PATH: "/fake/herdr" }, "linux");
	assert.deepEqual(await application.removeHerdrVisualsBlocks(apply), { status: "requested" });
	assert.deepEqual(await application.removeHerdrVisualsBlocks(apply), { status: "unchanged" });
	assert.equal(calls, 1);
});

test("platform replacement is awaited before reload without POSIX staging", async t => {
	const h = fixture(t); const order: string[] = [];
	const apply = createHerdrVisualsApplication({ configPath: h.path,
		replace: async (before: string, after: string) => {
			assert.equal(before, h.before); assert.match(after, /name = "nord"/);
			assert.equal(h.bytes(), h.before); order.push("replace");
		}, reload: async () => { order.push("reload"); } });
	assert.deepEqual(await apply(projection), { status: "requested" });
	assert.deepEqual(order, ["replace", "reload"]);
	assert.equal(h.bytes(), h.before);
	assert.deepEqual(fs.readdirSync(h.home), ["config.toml"]);
});

test("indeterminate platform replacement reports partial state without reload or retry", async t => {
	const h = fixture(t); let calls = 0;
	const apply = createHerdrVisualsApplication({ configPath: h.path,
		replace: async () => { calls++; throw new Error("Herdr configuration state unknown; no reload requested"); },
		reload: async () => assert.fail("no reload") });
	assert.deepEqual(await apply(projection), { status: "partial", stage: "config", error: "Herdr configuration state unknown; no reload requested" });
	assert.equal(calls, 1); assert.equal(h.bytes(), h.before);
	assert.deepEqual(fs.readdirSync(h.home), ["config.toml"]);
});

test("service replaces legacy owned message backgrounds with native surfaces only once", async t => {
	const h = fixture(t);
	const old = { ...projection, theme: { name: "catppuccin" as const, custom: Object.fromEntries(
		["sidebar_bg", "panel_bg", "active_row_bg", "selection_bg", "accent", "text", "red", "green"]
			.map(key => [key, "#d01199"]),
	) as any } };
	assert.deepEqual(await h.apply(old), { status: "requested" });
	assert.match(h.bytes(), /sidebar_bg = "#d01199"/);
	const current = { ...projection, theme: { name: "catppuccin" as const, custom: { accent: "#abcdef", text: "#eeeeee", red: "#ee0000",
		green: "#00ee00", subtext0: "#999999", overlay0: "#999999", overlay1: "#aaaaaa", mauve: "#bbbbbb" } } };
	assert.deepEqual(await h.apply(current), { status: "requested" });
	assert.doesNotMatch(h.bytes(), /(?:sidebar_bg|panel_bg|active_row_bg|selection_bg) =/);
	assert.match(h.bytes(), /accent = "#abcdef"/);
	assert.ok(h.bytes().includes('# retained\n[server]\nport = 1234\n'));
	assert.equal(fs.statSync(h.path).mode & 0o777, 0o640);
	const before = h.bytes(), inode = fs.statSync(h.path).ino;
	assert.deepEqual(h.reloads, [h.reloads[0], before]);
	assert.deepEqual(await h.apply(current), { status: "unchanged" });
	assert.equal(h.bytes(), before); assert.equal(fs.statSync(h.path).ino, inode);
	assert.equal(h.reloads.length, 2);
	const invalid = { ...current, theme: { ...current.theme, custom: { ...current.theme.custom, surprise: "#123456" } } } as unknown as HerdrVisualsProjection;
	assert.deepEqual(await h.apply(invalid), { status: "partial", stage: "config", error: "Invalid Herdr visuals projection; no changes proposed." });
	assert.equal(h.bytes(), before); assert.equal(fs.statSync(h.path).ino, inode);
	assert.equal(fs.statSync(h.path).mode & 0o777, 0o640); assert.equal(h.reloads.length, 2);
});
