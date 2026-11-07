import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { applyRemoteHerdrVisuals, REMOTE_READ_COMMAND, REMOTE_WRITE_COMMAND } from "../lib/herdr-remote-config.ts";
import type { HerdrRunner } from "../lib/herdr-machines.ts";
import { planHerdrVisualsConfig } from "../lib/herdr-visuals-config.ts";
// All shell executions below are confined to disposable config paths.
const shellTest = process.platform === "win32" ? test.skip : test;
function shellFixture(t: test.TestContext) {
 const dir = fs.mkdtempSync(join(tmpdir(), "gentle-herdr-remote-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const path = join(dir, "config.toml"), bin = join(dir, "bin"); fs.mkdirSync(bin);
 const env = { ...process.env, HERDR_CONFIG_PATH: path, PATH: `${bin}:${process.env.PATH}` };
 const run = (input: string, script = REMOTE_WRITE_COMMAND) => spawnSync("/bin/sh", ["-c", script], { env, input, encoding: "utf8" });
 const stub = (name: string, body: string) => fs.writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
 const real = (name: string) => spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
 const clean = () => assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes("gentle-herdr") && !n.includes("backup")), []);
 return { dir, path, run, stub, real, clean };
}
shellTest("shell creates absent config, reads it, updates and preserves mode", t => {
 const h = shellFixture(t);
 assert.equal(h.run("-\nfirst").status, 0);
 assert.equal(h.run("", REMOTE_READ_COMMAND).stdout, `${h.path}\n${sha("first")}\nfirst`);
 fs.chmodSync(h.path, 0o640);
 assert.equal(h.run(`${sha("first")}\nsecond`).status, 0);
 assert.equal(fs.readFileSync(h.path, "utf8"), "second");
 assert.equal(fs.statSync(h.path).mode & 0o777, 0o640); h.clean();
});
shellTest("shell hash mismatch restores original, and unexpected existing file conflicts", t => {
 const h = shellFixture(t); fs.writeFileSync(h.path, "external");
 for (const hash of [sha("stale"), "-"]) {
  assert.equal(h.run(`${hash}\nnew`).status, 73);
  assert.equal(fs.readFileSync(h.path, "utf8"), "external"); h.clean();
 }
});
shellTest("shell rejects oversized input and unsupported uname for read and write", t => {
 const h = shellFixture(t);
 assert.equal(h.run(`-\n${"x".repeat(262145)}`).status, 65); h.clean();
 h.stub("uname", "printf 'MINGW64_NT\\n'");
 for (const script of [REMOTE_READ_COMMAND, REMOTE_WRITE_COMMAND]) assert.equal(h.run("-\nnew", script).status, 70);
 assert.equal(fs.existsSync(h.path), false); h.clean();
});
for (const absent of [false, true]) shellTest(`shell commit link never overwrites appeared target (absent=${absent})`, t => {
 const h = shellFixture(t); if (!absent) fs.writeFileSync(h.path, "original");
 const ln = h.real("ln");
 h.stub("ln", `case "$1" in *.gentle-herdr.stage.*) printf external > "$HERDR_CONFIG_PATH" ;; esac\nexec "${ln}" "$@"`);
 const result = h.run(`${absent ? "-" : sha("original")}\nnew`);
 assert.equal(result.status, 73); assert.equal(fs.readFileSync(h.path, "utf8"), "external");
 const backups = fs.readdirSync(h.dir).filter(n => n.includes("backup"));
 assert.equal(backups.length, absent ? 0 : 1);
 if (!absent) {
  assert.equal(fs.readFileSync(join(h.dir, backups[0]!), "utf8"), "original");
  assert.match(result.stderr, new RegExp(backups[0]!.replaceAll(".", "\\.")));
  assert.ok(!result.stderr.includes(h.dir));
 }
 h.clean();
});
for (const phase of ["commit", "restore"] as const) for (const kind of ["directory", "symlink-directory"] as const) {
 for (const absent of phase === "commit" ? [false, true] : [false]) {
  shellTest(`shell ${phase} refuses raced ${kind} (absent=${absent})`, async t => {
   const h = shellFixture(t), ln = h.real("ln");
   const original = '[theme]\nname = "dracula"\n';
   if (!absent) fs.writeFileSync(h.path, original);
   const external = kind === "directory" ? h.path : join(h.dir, "external");
   if (kind === "symlink-directory") fs.mkdirSync(external);
   const inject = kind === "directory"
    ? 'mkdir "$HERDR_CONFIG_PATH"'
    : `"${ln}" -s "${external}" "$HERDR_CONFIG_PATH"`;
   h.stub("ln", `case "$1" in *.gentle-herdr.${phase === "commit" ? "stage" : "backup"}.*) ${inject}\nprintf sentinel > "${external}/sentinel" ;; esac\nexec "${ln}" "$@"`);
   let reloads = 0, write: ReturnType<typeof h.run> | undefined;
   const result = await applyRemoteHerdrVisuals(machine, projection, async (bin, args, options) => {
    if (bin !== "ssh") { reloads++; return ok(); }
    if (args.at(-1) === REMOTE_READ_COMMAND) return ok(`${h.path}\n${absent ? "-" : sha(original)}\n${absent ? "" : original}`);
    // A stale hash triggers the restore path before the commit link.
    write = h.run(phase === "restore" ? `${sha("stale")}\nnew` : options.input!);
    return ok(write.stdout, write.status!, write.stderr);
   });
   assert.equal(write?.status, 73);
   assert.equal(write?.stdout, "");
   assert.equal(result.status, "conflict"); assert.equal(reloads, 0);
   assert.equal(fs.lstatSync(h.path).isSymbolicLink(), kind === "symlink-directory");
   assert.deepEqual(fs.readdirSync(external), ["sentinel"]);
   assert.equal(fs.readFileSync(join(external, "sentinel"), "utf8"), "sentinel");
   const backups = fs.readdirSync(h.dir).filter(n => n.includes("backup"));
   assert.equal(backups.length, absent ? 0 : 1);
   if (!absent) {
    assert.equal(fs.readFileSync(join(h.dir, backups[0]!), "utf8"), original);
    assert.equal(result.backup, backups[0]);
    assert.equal(write?.stderr, `backup:${backups[0]}\n`);
   }
   h.clean();
  });
 }
}
shellTest("TERM before commit cleans staging and lock and exits 143", t => {
 const h = shellFixture(t), sha256sum = h.real("sha256sum"); fs.writeFileSync(h.path, "original");
 h.stub("sha256sum", `kill -TERM "$PPID"\nexec "${sha256sum}" "$@"`);
 assert.equal(h.run(`${sha("original")}\nnew`).status, 143);
 assert.equal(fs.readFileSync(h.path, "utf8"), "original"); h.clean();
});
shellTest("TERM after commit retains marker and cleans staging and lock", t => {
 const h = shellFixture(t), ln = h.real("ln");
 h.stub("ln", `"${ln}" "$@" || exit $?\nkill -TERM "$PPID"`);
 const result = h.run("-\nnew");
 assert.equal(result.status, 143); assert.match(result.stdout, /^committed$/m);
 assert.equal(fs.readFileSync(h.path, "utf8"), "new"); h.clean();
});
const machine = { id: "a", label: "Office", target: "user@host", enabled: true };
const projection = { theme: { name: "nord" }, taskSummaryStyle: { fg: "#123456", dim: false, bold: false } } as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ok = (stdout = "", code = 0, stderr = "") => ({ stdout: Buffer.from(stdout), code, stderr });
function fixture(raw = "", absent = false, writeCode = 0) {
 const calls: { bin: string; args: string[]; input?: string }[] = [];
 const runner: HerdrRunner = async (bin, args, options) => {
  calls.push({ bin, args, input: options.input });
  if (bin === "herdr") return ok();
  assert.deepEqual(args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", machine.target, args[6]]);
  assert.ok(options.maxBuffer <= 270000);
  if (args[6] === REMOTE_READ_COMMAND) {
   assert.equal(options.input, undefined);
   return ok(`/remote/config.toml\n${absent ? "-" : sha(raw)}\n${raw}`);
  }
  assert.equal(args[6], REMOTE_WRITE_COMMAND);
  assert.equal(options.input?.split("\n")[0], absent ? "-" : sha(raw));
  assert.ok(options.input?.includes("[theme]"));
  const plan = planHerdrVisualsConfig(raw, projection); assert.ok(plan.ok);
  assert.equal(options.input, `${absent ? "-" : sha(raw)}\n${plan.text}`);
  assert.ok(!args.join(" ").includes("#123456"), "content only travels through stdin");
  assert.ok(!args.join(" ").includes(sha(raw)), "expected hash only travels through stdin");
  return ok("", writeCode);
 };
 return { runner, calls };
}
test("committed marker overrides nonzero write exit and requests reload", async () => {
 const h = fixture();
 const result = await applyRemoteHerdrVisuals(machine, projection, async (bin, args, options) => {
  const answer = await h.runner(bin, args, options);
  return args[6] === REMOTE_WRITE_COMMAND ? ok("committed\n", 143) : answer;
 });
 assert.equal(result.status, "applied"); assert.equal(h.calls.length, 3);
});
test("conflict reports only a safe backup basename and never reloads", async () => {
 for (const name of ["config.toml.gentle-herdr.backup.ABC123", "/private/config.backup", "bad\\\\name"]) {
  const h = fixture();
  const result = await applyRemoteHerdrVisuals(machine, projection, async (bin, args, options) => {
   const answer = await h.runner(bin, args, options);
   return args[6] === REMOTE_WRITE_COMMAND ? ok("", 73, `backup:${name}\n`) : answer;
  });
  assert.equal(result.status, "conflict"); assert.equal(h.calls.length, 2);
  assert.equal(result.backup, name.startsWith("config.") ? name : undefined);
 }
});
test("dedicated platform refusal is unsupported without error text", async () => {
 assert.equal((await applyRemoteHerdrVisuals(machine, projection, async () => ok("", 70))).status, "unsupported");
});
test("invalid UTF-8 config is invalid-config, never written", async () => {
 let calls = 0;
 const result = await applyRemoteHerdrVisuals(machine, projection, async () => {
  calls++;
  return { code: 0, stderr: "", stdout: Buffer.concat([Buffer.from(`/config\n${sha("")}\n`), Buffer.from([0xff])]) };
 });
 assert.equal(result.status, "invalid-config"); assert.equal(calls, 1);
});
test("remote fixed scripts use bounded read, private sibling staging and no-overwrite commit", async () => {
 const h = fixture('# secret user comment\r\n[theme]\r\nname = "dracula"\r\n[theme.custom]\r\naccent = "reset"\r\n');
 assert.equal((await applyRemoteHerdrVisuals(machine, projection, h.runner)).status, "applied");
 assert.equal(h.calls.length, 3);
 assert.deepEqual(h.calls[2]?.args, ["--machine", "Office", "server", "reload-config"]);
 assert.match(REMOTE_READ_COMMAND, /HERDR_CONFIG_PATH/); assert.match(REMOTE_READ_COMMAND, /XDG_CONFIG_HOME/);
 assert.match(REMOTE_READ_COMMAND, /262144/);
 assert.match(REMOTE_WRITE_COMMAND, /umask 077/); assert.match(REMOTE_WRITE_COMMAND, /mktemp/);
 assert.match(REMOTE_WRITE_COMMAND, /chmod/); assert.match(REMOTE_WRITE_COMMAND, /sha256sum/);
 assert.match(REMOTE_WRITE_COMMAND, /ln/);
 assert.match(REMOTE_WRITE_COMMAND, /trap/);
 assert.ok(REMOTE_WRITE_COMMAND.includes('[ "$current" = "$expected" ]'));
 assert.ok(h.calls[1]?.input?.includes('accent = "reset"\r\n'));
});
test("CAS conflict never reloads; absent-file sentinel is sent unchanged", async () => {
 const conflict = fixture("", false, 73);
 assert.equal((await applyRemoteHerdrVisuals(machine, projection, conflict.runner)).status, "conflict");
 assert.equal(conflict.calls.length, 2);
 const absent = fixture("", true);
 assert.equal((await applyRemoteHerdrVisuals(machine, projection, absent.runner)).status, "applied");
 assert.match(REMOTE_WRITE_COMMAND, /\[ ! -e/);
});
test("unchanged content never writes or reloads; unsupported TOML fails closed", async () => {
 const planned = planHerdrVisualsConfig("", projection); assert.ok(planned.ok);
 const h = fixture(planned.text);
 assert.equal((await applyRemoteHerdrVisuals(machine, projection, h.runner)).status, "unchanged"); assert.equal(h.calls.length, 1);
 const bad = fixture("[theme\n");
 assert.equal((await applyRemoteHerdrVisuals(machine, projection, bad.runner)).status, "invalid-config"); assert.equal(bad.calls.length, 1);
});
test("invalid targets, Windows/no sh, auth, unreachable, oversized and hash mismatch are sanitized", async () => {
 assert.equal((await applyRemoteHerdrVisuals({ ...machine, target: "-bad" }, projection, async () => assert.fail())).status, "unsupported");
 for (const [code, stderr, expected] of [[127, "sh: not found", "unsupported"], [255, "'sh' is not recognized as an internal command", "unsupported"], [255, "Permission denied (publickey). SECRET", "auth"], [255, "Connection refused SECRET", "unreachable"]] as const) {
  const result = await applyRemoteHerdrVisuals(machine, projection, async () => ok("", code, stderr));
  assert.equal(result.status, expected); assert.ok(!JSON.stringify(result).includes("SECRET"));
 }
 for (const stdout of [`/config\n${sha("")}\n${"x".repeat(262145)}`, `/config\n${sha("wrong")}\n`, "/config\n-\nnot empty"] ) {
  assert.equal((await applyRemoteHerdrVisuals(machine, projection, async () => ok(stdout))).status, "invalid-config");
 }
 const h = fixture();
 assert.equal((await applyRemoteHerdrVisuals(machine, projection, async (bin, args, options) => bin === "herdr" ? ok("", 1) : h.runner(bin, args, options))).status, "reload-failed");
});
