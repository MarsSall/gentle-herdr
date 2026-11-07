import { execFile } from "node:child_process";

export interface HerdrMachine { id: string; label: string; target: string; enabled: boolean }
export interface HerdrRunOptions { input?: string; maxBuffer: number; timeout: number }
export interface HerdrRunResult { code: number; stdout: Buffer; stderr: string }
export type HerdrRunner = (binary: string, args: string[], options: HerdrRunOptions) => Promise<HerdrRunResult>;
/** No shell, bounded pipes and wall time. Error text never leaves the protocol layer. */
export const runHerdrCommand: HerdrRunner = (binary, args, options) => new Promise((resolve, reject) => {
 const child = execFile(binary, args, { encoding: "buffer", maxBuffer: options.maxBuffer,
  timeout: options.timeout, windowsHide: true }, (error, stdout, stderr) => {
  if (error && (typeof error.code !== "number" || error.killed)) { reject(new Error("Command unavailable or exceeded limits")); return; }
  resolve({ code: error ? Number(error.code) : 0, stdout, stderr: stderr.toString("utf8") });
 });
 child.stdin?.on("error", () => { /* Early remote exit is classified by exit status. */ });
 child.stdin?.end(options.input ?? "");
});
export function validMachineTarget(target: string): boolean {
 return target.length > 0 && target.length <= 1024 && !target.startsWith("-") && /^[A-Za-z0-9_@.:[\]%-]+$/.test(target);
}
const safeName = (value: unknown): value is string => typeof value === "string" && value.length > 0
 && value.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
export async function listHerdrMachines(runner: HerdrRunner = runHerdrCommand, binary = "herdr"): Promise<HerdrMachine[]> {
 try {
  const result = await runner(binary, ["machine", "list", "--json"], { maxBuffer: 256 * 1024, timeout: 5000 });
  if (result.code !== 0 || result.stdout.length > 256 * 1024) throw new Error();
  const rows: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
  if (!Array.isArray(rows)) throw new Error();
  const ids = new Set<string>();
  const machines = rows.map((value: unknown): HerdrMachine => {
   if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
   const row = value as Record<string, unknown>;
   if (!safeName(row.id) || !safeName(row.label) || typeof row.target !== "string" || !validMachineTarget(row.target)
    || typeof row.enabled !== "boolean" || ids.has(row.id)) throw new Error();
   ids.add(row.id);
   return { id: row.id, label: row.label, target: row.target, enabled: row.enabled };
  });
  return machines.filter(machine => machine.enabled);
 } catch { throw new Error("Cannot read saved Herdr machines (invalid list or command unavailable)"); }
}
