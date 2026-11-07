import { createHash } from "node:crypto";
import { runHerdrCommand, validMachineTarget, type HerdrMachine, type HerdrRunner } from "./herdr-machines.ts";
import { planHerdrVisualsConfig, type HerdrVisualsProjection } from "./herdr-visuals-config.ts";

export type HerdrRemoteStatus = "unchanged" | "applied" | "conflict" | "unreachable" | "auth" | "unsupported" | "invalid-config" | "reload-failed";
export interface HerdrRemoteResult { id: string; label: string; status: HerdrRemoteStatus; backup?: string }
const MAX_BYTES = 262144;
// These commands are constants. SSH joins remote argv into a shell command, so
// quote the entire fixed script, never a path, preference, hash or config value.
const command = (script: string) => `sh -c '${script.replaceAll("'", "'\\''")}'`;
const pathScript = `
set -eu
umask 077
case "$(uname -s 2>/dev/null || :)" in Linux|Darwin|*BSD) ;; *) exit 70 ;; esac
path=\${HERDR_CONFIG_PATH:-\${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml}
case "$path" in /*) ;; *) exit 65 ;; esac
case "$path" in *"$(printf '\\r')"*|*"
"*) exit 65 ;; esac
[ ! -L "$path" ] || exit 65
command -v sha256sum >/dev/null 2>&1 || exit 69
`;
export const REMOTE_READ_COMMAND = command(pathScript + `
if [ -e "$path" ]; then
 [ -f "$path" ] || exit 65
 [ "$(wc -c < "$path")" -le 262144 ] || exit 65
 hash=$(sha256sum < "$path"); hash=\${hash%% *}
 printf "%s\\n%s\\n" "$path" "$hash"
 head -c 262145 < "$path"
else
 printf "%s\\n-\\n" "$path"
fi
`);
export const REMOTE_WRITE_COMMAND = command(pathScript + `
IFS= read -r expected || exit 65
case "$expected" in -) ;; *[!a-f0-9]*|"") exit 65 ;; *) [ "\${#expected}" -eq 64 ] || exit 65 ;; esac
parent=\${path%/*}
mkdir -p "$parent"
# Serialize package writers; the commit itself must never replace a path.
lock="$path.gentle-herdr.lock"
mkdir "$lock" 2>/dev/null || exit 73
tmp=""; aside=""; linking=0; committed=0
mark_committed() {
 if [ "$committed" = 0 ]; then
  committed=1
  printf 'committed\\n'
 fi
}
# GNU and BSD stat both expose device/inode, with different format switches.
same_file() {
 [ -f "$2" ] && [ ! -L "$2" ] || return 1
 source_id=$(stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1") || return 1
 target_id=$(stat -c '%d:%i' "$2" 2>/dev/null || stat -f '%d:%i' "$2") || return 1
 [ "$source_id" = "$target_id" ]
}
remove_stray() {
 # ln may interpret a raced directory (including a symlink) as its destination.
 stray="$path/\${1##*/}"
 if [ -d "$path" ] && same_file "$1" "$stray"; then rm -f -- "$stray" || :; fi
}
restore() {
 [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
 ln "$aside" "$path" 2>/dev/null || :
 if same_file "$aside" "$path"; then return 0; fi
 remove_stray "$aside"
 return 1
}
cleanup() {
 # A signal can arrive after ln succeeds but before the next shell statement.
 if [ "$linking" = 1 ] && [ -n "$tmp" ]; then
  if same_file "$tmp" "$path"; then mark_committed; else remove_stray "$tmp"; fi
 fi
 if [ -n "$aside" ] && { [ -e "$aside" ] || [ -L "$aside" ]; }; then
  if [ "$committed" = 1 ] || restore; then
   rm -f -- "$aside" || :
  else
   printf 'backup:%s\\n' "\${aside##*/}" >&2
  fi
 fi
 [ -z "$tmp" ] || rm -f -- "$tmp" || :
 rmdir "$lock" 2>/dev/null || :
}
trap 'cleanup' EXIT
trap 'trap - EXIT HUP INT TERM; cleanup; exit 129' HUP
trap 'trap - EXIT HUP INT TERM; cleanup; exit 130' INT
trap 'trap - EXIT HUP INT TERM; cleanup; exit 143' TERM
tmp=$(mktemp "$path.gentle-herdr.stage.XXXXXXXX") || exit 65
head -c 262145 > "$tmp"
[ "$(wc -c < "$tmp")" -le 262144 ] || exit 65
# Reuse the private stage nonce for an initially absent backup sibling.
candidate="$path.gentle-herdr.backup.\${tmp##*.}"
[ ! -e "$candidate" ] && [ ! -L "$candidate" ] || exit 73
aside="$candidate"
if [ -e "$path" ] || [ -L "$path" ]; then
 mv -f -- "$path" "$aside" || exit 73
 [ "$expected" != - ] && [ -f "$aside" ] && [ ! -L "$aside" ] || exit 73
 current=$(sha256sum < "$aside"); current=\${current%% *}
 [ "$current" = "$expected" ] || exit 73
 mode=$(stat -c %a "$aside" 2>/dev/null || stat -f %Lp "$aside") || exit 69
 chmod "$mode" "$tmp"
else
 rm -f -- "$aside"; aside=""
 [ "$expected" = - ] || exit 73
fi
[ ! -e "$path" ] && [ ! -L "$path" ] || exit 73
linking=1
ln "$tmp" "$path" 2>/dev/null || exit 73
same_file "$tmp" "$path" || exit 73
mark_committed

`);
function failure(code: number, stderr: string): HerdrRemoteStatus {
 if (code === 73) return "conflict";
 if (code === 65) return "invalid-config";
 if (code === 70 || code === 69 || code === 127 || /(?:sh.*(?:not found|not recognized)|(?:not found|not recognized).*sh)/i.test(stderr)) return "unsupported";
 if (/permission denied|authentication failed|host key verification failed/i.test(stderr)) return "auth";
 return "unreachable";
}
/** Read/plan/write/reload are isolated per machine. No raw errors or config bytes
 * are returned. The caller applies local preferences first and handles discovery.
 */
export async function applyRemoteHerdrVisuals(machine: HerdrMachine, projection: HerdrVisualsProjection,
 runner: HerdrRunner = runHerdrCommand, binary = "herdr"): Promise<HerdrRemoteResult> {
 const result = (status: HerdrRemoteStatus): HerdrRemoteResult => ({ id: machine.id, label: machine.label, status });
 if (!machine.enabled || !validMachineTarget(machine.target)) return result("unsupported");
 const ssh = (script: string, input?: string) => runner("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", machine.target, script],
  { input, maxBuffer: MAX_BYTES + 4096, timeout: 30000 });
 try {
  const read = await ssh(REMOTE_READ_COMMAND);
  if (read.code !== 0) return result(failure(read.code, read.stderr));
  if (read.stdout.length > MAX_BYTES + 4096) return result("invalid-config");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(read.stdout); }
  catch { return result("invalid-config"); }
  const first = text.indexOf("\n"), second = text.indexOf("\n", first + 1);
  const path = text.slice(0, first), hash = text.slice(first + 1, second), raw = text.slice(second + 1);
  if (first < 1 || second < 0 || !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)
   || Buffer.byteLength(raw) > MAX_BYTES || !(hash === "-" ? raw === "" : /^[a-f0-9]{64}$/.test(hash)
    && createHash("sha256").update(raw).digest("hex") === hash)) return result("invalid-config");
  const plan = planHerdrVisualsConfig(raw, projection);
  if (!plan.ok || Buffer.byteLength(plan.text) > MAX_BYTES) return result("invalid-config");
  if (!plan.changed) return result("unchanged");
  const write = await ssh(REMOTE_WRITE_COMMAND, `${hash}\n${plan.text}`);
  if (write.code !== 0 && !write.stdout.toString("utf8").split("\n").includes("committed")) {
   const answer = result(failure(write.code, write.stderr));
   const backup = /^backup:([^/\\\\\x00-\x1f\x7f]+)$/m.exec(write.stderr)?.[1];
   if (answer.status === "conflict" && backup) answer.backup = backup;
   return answer;
  }
  try {
   const reload = await runner(binary, ["--machine", machine.label, "server", "reload-config"], { maxBuffer: 4096, timeout: 10000 });
   return result(reload.code === 0 ? "applied" : "reload-failed");
  } catch { return result("reload-failed"); }
 } catch { return result("unreachable"); }
}
