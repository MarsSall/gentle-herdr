import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeWindowsReplacementRequest, replaceWindowsHerdrConfig, windowsReplacementProgram } from "../lib/herdr-windows-replacement.ts";

test("Windows request wire preserves Unicode paths through non-UTF8 console decoding", () => {
	const value = { path: String.raw`C:\fixture\café-配置-😀.toml`, before: "ancien é", after: "nuevo 配置 😀" };
	const wire = encodeWindowsReplacementRequest(value);
	assert.match(wire, /^[A-Za-z0-9+/]+={0,2}$/);
	// A legacy single-byte console decoder must receive ASCII, not path bytes.
	const consoleLine = Buffer.from(wire, "utf8").toString("latin1");
	assert.equal(consoleLine, wire);
	const payload = JSON.parse(Buffer.from(consoleLine, "base64").toString("utf8"));
	assert.equal(payload.path, value.path);
	assert.equal(Buffer.from(payload.before, "base64").toString("utf8"), value.before);
	assert.equal(Buffer.from(payload.after, "base64").toString("utf8"), value.after);
});

const request = Object.freeze({ path: String.raw`C:\fixture\config.toml`, before: "old fixture", after: "new fixture" });
test("Windows replacement accepts only an exact confirmed helper result", async () => {
	let calls = 0;
	await replaceWindowsHerdrConfig(request, async value => {
		calls++; assert.deepEqual(value, request); return '{"status":"replaced"}\n';
	});
	assert.equal(calls, 1);
});
test("Windows helper failure or ambiguous output never retries and reports uncertainty", async () => {
	for (const reply of ["", "garbage", '{}', '{"status":"replaced","extra":true}', '{"status":"unknown"}']) {
		let calls = 0;
		await assert.rejects(replaceWindowsHerdrConfig(request, async () => { calls++; return reply; }), { message: "Herdr configuration state unknown; no reload requested" });
		assert.equal(calls, 1);
	}
	let calls = 0;
	await assert.rejects(replaceWindowsHerdrConfig(request, async () => { calls++; throw new Error("private diagnostic"); }), { message: "Herdr configuration state unknown; no reload requested" });
	assert.equal(calls, 1);
});

// Behavior is exercised on Windows by the isolated harness; this pins the shipped text.
test("Windows helper names its File.Replace backup and restores the original on failure", () => {
	const program = windowsReplacementProgram;
	// ReplaceFile can move the original aside and then fail; an internal ~RF name
	// would leave no config and nothing to restore.
	assert.doesNotMatch(program, /Replace\(\$temporary, \$path, \[System\.Management\.Automation\.Language\.NullString\]::Value/);
	assert.match(program, /\$backup = \$path \+ '\.' \+ \[Guid\]::NewGuid\(\)\.ToString\('N'\) \+ '\.bak'/);
	// A failing restoration never hides the replacement failure.
	assert.match(program, /try \{ \[IO\.File\]::Replace\(\$temporary, \$path, \$backup, \$false\) \} catch \{ try \{ Restore-Replaced \$path \$backup \} catch \{ \}; throw \}/);
	// Restoration retries the move briefly, then falls back to a copy that keeps
	// the backup; neither form can overwrite a config that exists again.
	const restore = /function Restore-Replaced\(\$path, \$backup\) \{\n[\s\S]*?\n\}\n/.exec(program)?.[0] ?? "";
	assert.match(restore, /for \(\$attempt = 0; \$attempt -lt 5; \$attempt\+\+\)/);
	assert.match(restore, /\[IO\.File\]::Move\(\$backup, \$path\)/);
	assert.match(restore, /Start-Sleep -Milliseconds 200/);
	assert.match(restore, /\[IO\.File\]::Copy\(\$backup, \$path, \$false\)/);
	assert.equal((restore.match(/Test-Path -LiteralPath \$path/g) ?? []).length >= 2, true);
	// The original copy is discarded only after the replacement is confirmed.
	const confirmed = program.indexOf("throw 'Unconfirmed replacement'");
	const removed = program.indexOf("Remove-Item -Force -LiteralPath $backup");
	assert.ok(confirmed > 0 && removed > confirmed);
	assert.ok(removed < program.indexOf("'{\"status\":\"replaced\"}'"));
});

// Runs the shipped helper with Windows PowerShell; other platforms skip it.
const windows = { skip: process.platform !== "win32" && "requires Windows PowerShell and NTFS" };
const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function runPowerShell(script: string, input: string): { status: number; stdout: string } {
	const bootstrap = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))";
	try {
		const stdout = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")],
			{ input: Buffer.from(script, "utf8").toString("base64") + "\n" + input, encoding: "utf8", timeout: 30000, windowsHide: true, stdio: "pipe" });
		return { status: 0, stdout: stdout.trim() };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string };
		return { status: failure.status ?? -1, stdout: String(failure.stdout ?? "").trim() };
	}
}
function ownedConfig(directory: string, name: string, text: string): string {
	const path = join(directory, name);
	writeFileSync(path, text);
	// Elevated sessions create files owned by Administrators; the helper requires the current user.
	runPowerShell("$a=Get-Acl -LiteralPath $args0;$a.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User);Set-Acl -LiteralPath $args0 -AclObject $a".replaceAll("$args0", `'${path.replaceAll("'", "''")}'`), "");
	return path;
}
const restoreFunction = /function Restore-Replaced\(\$path, \$backup\) \{\n[\s\S]*?\n\}/.exec(windowsReplacementProgram)?.[0] ?? "";
function restore(path: string, backup: string, hold?: "Read" | "None"): string {
	const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const lock = hold ? `$h=[IO.File]::Open(${quote(backup)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::${hold});` : "$h=$null;";
	return runPowerShell(`${restoreFunction}\n${lock}try { Restore-Replaced ${quote(path)} ${quote(backup)}; 'ok' } catch { 'threw' } finally { if ($h) { $h.Dispose() } }`, "").stdout;
}

test("Windows helper replaces a config, keeps its descriptor and leaves no stage or backup", windows, () => {
	const directory = mkdtempSync(join(tmpdir(), "gentle-replace-"));
	try {
		const path = ownedConfig(directory, "config.toml", "old fixture");
		const acl = () => runPowerShell(`(Get-Acl -LiteralPath '${path}').Sddl`, "").stdout;
		const before = acl();
		const replaced = runPowerShell(windowsReplacementProgram, encodeWindowsReplacementRequest({ path, before: "old fixture", after: "new fixture" }) + "\n");
		assert.deepEqual(replaced, { status: 0, stdout: '{"status":"replaced"}' });
		assert.equal(readFileSync(path, "utf8"), "new fixture");
		assert.equal(acl(), before);
		assert.deepEqual(runPowerShell(`@(Get-ChildItem -LiteralPath '${directory}' -Force).Count`, "").stdout, "1");
		const changed = runPowerShell(windowsReplacementProgram, encodeWindowsReplacementRequest({ path, before: "old fixture", after: "other" }) + "\n");
		assert.deepEqual(changed, { status: 1, stdout: '{"status":"unknown"}' });
		assert.equal(readFileSync(path, "utf8"), "new fixture");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Windows recovery puts the original back, falls back to a copy and never overwrites", windows, () => {
	const directory = mkdtempSync(join(tmpdir(), "gentle-restore-"));
	const read = (name: string) => readFileSync(join(directory, name), "utf8");
	const exists = (name: string) => runPowerShell(`Test-Path -LiteralPath '${join(directory, name)}'`, "").stdout === "True";
	try {
		writeFileSync(join(directory, "a.bak"), "original");
		assert.equal(restore(join(directory, "a.toml"), join(directory, "a.bak")), "ok");
		assert.equal(read("a.toml"), "original");
		assert.equal(exists("a.bak"), false);
		writeFileSync(join(directory, "b.toml"), "current"); writeFileSync(join(directory, "b.bak"), "stale");
		assert.equal(restore(join(directory, "b.toml"), join(directory, "b.bak")), "ok");
		assert.equal(read("b.toml"), "current");
		assert.equal(read("b.bak"), "stale");
		// Locked against deletion: moves fail, the copy restores and keeps the backup.
		writeFileSync(join(directory, "c.bak"), "locked original");
		assert.equal(restore(join(directory, "c.toml"), join(directory, "c.bak"), "Read"), "ok");
		assert.equal(read("c.toml"), "locked original");
		assert.equal(read("c.bak"), "locked original");
		// Fully locked: recovery fails, and the original stays intact at the backup name.
		writeFileSync(join(directory, "d.bak"), "only copy");
		assert.equal(restore(join(directory, "d.toml"), join(directory, "d.bak"), "None"), "threw");
		assert.equal(exists("d.toml"), false);
		assert.equal(read("d.bak"), "only copy");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
