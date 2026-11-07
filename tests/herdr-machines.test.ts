import assert from "node:assert/strict";
import test from "node:test";
import { listHerdrMachines, validMachineTarget, type HerdrRunner } from "../lib/herdr-machines.ts";

const machine = { id: "a", label: "Office", target: "user@host", enabled: true };
test("machine list uses bounded exec argv, validates every row, ignores disabled", async () => {
 const runner: HerdrRunner = async (bin, args, options) => {
  assert.equal(bin, "herdr"); assert.deepEqual(args, ["machine", "list", "--json"]);
  assert.ok(options.maxBuffer <= 256 * 1024); assert.ok(options.timeout > 0);
  return { code: 0, stdout: Buffer.from(JSON.stringify([machine, { ...machine, id: "b", enabled: false }])), stderr: "" };
 };
 assert.deepEqual(await listHerdrMachines(runner), [machine]);
 for (const row of [{ ...machine, id: 1 }, { ...machine, label: null }, { ...machine, target: 1 }, { ...machine, enabled: "true" }, { ...machine, target: "-host" }]) {
  await assert.rejects(listHerdrMachines(async () => ({ code: 0, stdout: Buffer.from(JSON.stringify([row])), stderr: "" })));
 }
 for (const raw of ["{}", "{", JSON.stringify([machine, machine]), " ".repeat(262145)]) {
  await assert.rejects(listHerdrMachines(async () => ({ code: 0, stdout: Buffer.from(raw), stderr: "" })));
 }
});
test("SSH targets reject options, whitespace, control characters and shell metacharacters", () => {
 for (const target of ["", "-host", "a b", "a\nb", "a\u0000b", "a\u007fb", "a;touch", "$(id)"]) assert.equal(validMachineTarget(target), false, target);
 for (const target of ["user@host", "host", "192.0.2.1", "user@[::1]"]) assert.equal(validMachineTarget(target), true);
});
