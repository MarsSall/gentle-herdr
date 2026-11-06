import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

export interface WindowsReplacementRequest {
	path: string;
	before: string;
	after: string;
}
export type WindowsReplacementTransport = (request: WindowsReplacementRequest) => Promise<string>;

/** Keep the entire request ASCII on the wire, regardless of the console code page. */
export function encodeWindowsReplacementRequest(request: WindowsReplacementRequest): string {
	return Buffer.from(JSON.stringify({ path: request.path, before: Buffer.from(request.before, "utf8").toString("base64"),
		after: Buffer.from(request.after, "utf8").toString("base64") }), "utf8").toString("base64");
}

// Fixed program: request data arrives separately, never interpolated into code.
// Namespace checks are bounded checks, not protection against hostile rename races.
// Exported so tests and the Windows harness exercise the shipped text.
export const windowsReplacementProgram = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Check-Path($path) {
    for ($p = $path; $p; $p = Split-Path $p) {
        if ((Get-Item -Force -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path' }
    }
}
# ReplaceFile can move the original to the backup name and then fail to move the
# replacement (ERROR_UNABLE_TO_MOVE_REPLACEMENT_2): put the original back. The same
# transient lock may block the move, so retry briefly (about one second, inside the
# caller's timeout), then copy and keep the backup. Neither form overwrites a
# config that exists again; if both fail, the original remains at $backup.
function Restore-Replaced($path, $backup) {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        if ((Test-Path -LiteralPath $path) -or !(Test-Path -LiteralPath $backup)) { return }
        try { [IO.File]::Move($backup, $path); return } catch { Start-Sleep -Milliseconds 200 }
    }
    if (!(Test-Path -LiteralPath $path)) { [IO.File]::Copy($backup, $path, $false) }
}
function Read-Bounded($path) {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt 262144) { throw 'Oversized config' }
        $buffer = [byte[]]::new(262145)
        $size = 0
        do { $count = $stream.Read($buffer, $size, $buffer.Length - $size); $size += $count } while ($count -and $size -lt $buffer.Length)
        if ($size -gt 262144 -or $size -ne $stream.Length) { throw 'Changed config' }
        return [Convert]::ToBase64String($buffer, 0, $size)
    } finally { $stream.Dispose() }
}
try {
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json
    $path = [string]$request.path
    if ($path -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($path) -cne $path) { throw 'Unsupported path' }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($path))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { throw 'Unsupported volume' }
    Check-Path $path
    $item = Get-Item -Force -LiteralPath $path
    if ($item.PSIsContainer -or ([int]$item.Attributes -band (-bnot 160))) { throw 'Unsupported attributes' }
    $streams = @(Get-Item -Force -LiteralPath $path -Stream *)
    if ($streams.Count -ne 1 -or $streams[0].Stream -ne ':$DATA') { throw 'Unsupported streams' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $originalAcl = Get-Acl -LiteralPath $path
    if ($originalAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsupported owner' }
    $sddl = $originalAcl.Sddl
    if ((Read-Bounded $path) -cne $request.before) { throw 'Changed config' }
    $bytes = [Convert]::FromBase64String($request.after)
    if ($bytes.Length -gt 262144) { throw 'Oversized result' }
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    $temporary = $path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $stage = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security)
    try {
        $actual = $stage.GetAccessControl()
        $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if (!$actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsafe staging ACL' }
        $stage.Write($bytes, 0, $bytes.Length)
        $stage.Flush($true)
    } finally { $stage.Dispose() }
    Check-Path $path
    Check-Path $temporary
    if ((Get-Acl -LiteralPath $path).Sddl -cne $sddl -or (Read-Bounded $path) -cne $request.before) { throw 'Changed config' }
    $backup = $path + '.' + [Guid]::NewGuid().ToString('N') + '.bak'
    try { [IO.File]::Replace($temporary, $path, $backup, $false) } catch { try { Restore-Replaced $path $backup } catch { }; throw }
    # An unconfirmed result keeps the original copy for manual inspection.
    if ((Get-Acl -LiteralPath $path).Sddl -cne $sddl -or (Read-Bounded $path) -cne $request.after) { throw 'Unconfirmed replacement' }
    try { Remove-Item -Force -LiteralPath $backup } catch { }
    [Console]::Out.WriteLine('{"status":"replaced"}')
} catch {
    [Console]::Out.WriteLine('{"status":"unknown"}')
    exit 1
}
`;

/** NTFS, current-owner files only. Failed staging may leave a private temporary
 * file; a failed File.Replace restores the original from its named backup. A
 * timeout/protocol failure is indeterminate, never proof of no write.
 */
export const windowsReplacementTransport: WindowsReplacementTransport = async request => {
	if (process.platform !== "win32") throw new Error("Windows replacement unavailable");
	const stat = lstatSync(request.path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 262144
		|| realpathSync(win32.dirname(request.path)) !== win32.dirname(request.path)) throw new Error("Unsupported Windows config");
	const executable = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const bootstrap = "$ErrorActionPreference='Stop'; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))";
	return new Promise((done, reject) => {
		const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")],
			{ timeout: 5000, maxBuffer: 4096, windowsHide: true }, (error, stdout, stderr) => error || stderr ? reject(new Error("Unconfirmed Windows replacement")) : done(stdout));
		child.stdin?.on("error", reject);
		child.stdin?.end(Buffer.from(windowsReplacementProgram, "utf8").toString("base64") + "\n" + encodeWindowsReplacementRequest(request) + "\n");
	});
};

/** A helper error may occur after replacement: callers must not retry or reload. */
export async function replaceWindowsHerdrConfig(
	request: WindowsReplacementRequest,
	transport: WindowsReplacementTransport = windowsReplacementTransport,
): Promise<void> {
	try {
		const result: unknown = JSON.parse(await transport(request));
		if (!result || typeof result !== "object" || Array.isArray(result)
			|| Object.keys(result).length !== 1 || (result as { status?: unknown }).status !== "replaced") throw new Error("Unconfirmed result");
	} catch {
		throw new Error("Herdr configuration state unknown; no reload requested");
	}
}
