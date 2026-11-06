import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { herdrDetected } from "./herdr-pane.ts";
import { resolveWindowsHerdrTarget } from "./herdr-windows-target.ts";
import { replaceWindowsHerdrConfig } from "./herdr-windows-replacement.ts";
import { planHerdrVisualsConfig, type HerdrVisualsProjection } from "./herdr-visuals-config.ts";
import { projectHerdrTheme, projectHerdrTaskSummaryStyle } from "./herdr-theme-projection.ts";
import type { HerdrVisualsSettings } from "./herdr-visuals-policy.ts";

export type HerdrVisualsApplicationResult =
	| { status: "unavailable"; reason?: "remote" }
	| { status: "unchanged" }
	| { status: "requested" }
	| { status: "partial"; stage: "config" | "reload"; error: string };
export type HerdrVisualsAction = "apply" | "remove";
export type HerdrVisualsApplication = (projection: HerdrVisualsProjection, action?: HerdrVisualsAction) => Promise<HerdrVisualsApplicationResult>;
export type HerdrVisualsAvailability = { available: true } | { available: false; reason: "remote" | "unavailable" };

/** The caller persists package preferences first. No preference store is read here. */
export async function applyHerdrVisualsPreferences(
	settings: HerdrVisualsSettings,
	palette: Parameters<typeof projectHerdrTheme>[0],
	application: HerdrVisualsApplication,
): Promise<HerdrVisualsApplicationResult> {
	try {
		return await application({ theme: projectHerdrTheme(palette, settings.theme),
			taskSummaryStyle: projectHerdrTaskSummaryStyle(palette, settings.summaryColor) }, "apply");
	} catch (error) { return { status: "partial", stage: "config", error: message(error) }; }
}

/** Removal requires neither a healthy preference store nor a usable live palette.
 * The planner validates this inert projection but never applies it on removal.
 */
export function removeHerdrVisualsBlocks(application: HerdrVisualsApplication): Promise<HerdrVisualsApplicationResult> {
	return application({ theme: { name: "one-dark" }, taskSummaryStyle: { fg: "#ffffff", dim: false, bold: false } }, "remove");
}
export interface HerdrVisualsApplicationOptions {
	configPath: string;
	reload(): Promise<void>;
	/** Platform-specific replacement; invoked only after planning and a fresh snapshot. */
	replace?(before: string, after: string): Promise<void>;
}
const MAX_BYTES = 256 * 1024;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
	&& a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode;

function snapshot(path: string): { bytes: Buffer; stat: Stats } {
	if (!isAbsolute(path) || resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) {
		throw new Error("Unsupported or symlinked Herdr config path");
	}
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) {
		throw new Error("Herdr config must be a bounded regular single-link file");
	}
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!same(before, stat)) throw new Error("Herdr config changed during read");
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let size = 0, count = 0;
		do { count = readSync(fd, buffer, size, buffer.length - size, size); size += count; } while (count && size < buffer.length);
		if (size > MAX_BYTES || size !== stat.size || !same(stat, fstatSync(fd))) throw new Error("Herdr config changed or exceeded read limit");
		return { bytes: buffer.subarray(0, size), stat };
	} finally { closeSync(fd); }
}

/** Only invoked after preference persistence. Replacement and IPC are separate
 * steps, not a transaction or a full compare-and-swap. Failed staging can leave
 * an exclusive same-directory temporary file; never retry or roll back silently.
 */
export function createHerdrVisualsApplication(options: HerdrVisualsApplicationOptions): HerdrVisualsApplication {
	return async (projection, action = "apply") => {
		try {
			const original = snapshot(options.configPath);
			const raw = new TextDecoder("utf-8", { fatal: true }).decode(original.bytes);
			const plan = planHerdrVisualsConfig(raw, projection, action);
			if (plan.ok === false) throw new Error(plan.error);
			if (!plan.changed) return { status: "unchanged" };
			if (options.replace) {
				const fresh = snapshot(options.configPath);
				if (!same(original.stat, fresh.stat) || !original.bytes.equals(fresh.bytes)) throw new Error("Herdr config changed before replacement");
				await options.replace(raw, plan.text);
			} else {
				const temporary = `${options.configPath}.${randomUUID()}.tmp`;
				const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
				try {
					writeFileSync(fd, plan.text, "utf8");
					fchmodSync(fd, original.stat.mode & 0o777);
					fsyncSync(fd);
				} finally { closeSync(fd); }
				const fresh = snapshot(options.configPath);
				if (!same(original.stat, fresh.stat) || !original.bytes.equals(fresh.bytes)) throw new Error("Herdr config changed before replacement");
				renameSync(temporary, options.configPath);
			}
		} catch (error) { return { status: "partial", stage: "config", error: message(error) }; }
		try {
			await options.reload();
			return { status: "requested" };
		} catch (error) { return { status: "partial", stage: "reload", error: message(error) }; }
	};
}

// Serialize this module's Windows actions, not unrelated external editors.
let windowsApplication: Promise<unknown> = Promise.resolve();

/** A managed Herdr pane reached over SSH. Herdr clients read theme and sidebar
 * from their own local config, so the server-side config is not what the user sees.
 */
export function herdrRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return herdrDetected(env) && !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

function localTarget(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { configPath: string; binary: string } | undefined {
	if (!herdrDetected(env) || env.GENTLE_PI_AGENTS_CHILD === "1"
		|| env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return undefined;
	const binary = env.HERDR_BIN_PATH ?? (platform === "win32" ? "herdr.exe" : "herdr");
	if (/^herdr-dev(?:\.exe)?$/i.test(win32.basename(basename(binary)))) return undefined;
	if (platform === "win32") return resolveWindowsHerdrTarget(env);
	if (platform !== "linux" || !isAbsolute(env.HERDR_SOCKET_PATH!)) return undefined;
	const root = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : undefined);
	const path = env.HERDR_CONFIG_PATH ?? (root ? join(root, "herdr", "config.toml") : undefined);
	if (!path || !isAbsolute(path) || resolve(path) !== path || !path.trim()) return undefined;
	return { configPath: path, binary };
}

/** Pure pre-Enter eligibility, not a filesystem health check or build attestation.
 * Remote means the client reads a different machine's config. Generic unavailable
 * covers missing markers, child/dev sessions, unsupported platforms and paths.
 */
export function localHerdrVisualsAvailability(env: NodeJS.ProcessEnv, platform = process.platform): HerdrVisualsAvailability {
	if (herdrRemoteSession(env)) return { available: false, reason: "remote" };
	return localTarget(env, platform) ? { available: true } : { available: false, reason: "unavailable" };
}

/** Re-evaluate the same pure guard at confirmation before touching any config.
 * Binary names are not build attestation; never guess a remote config.
 */
export function localHerdrVisualsApplication(env: NodeJS.ProcessEnv, platform = process.platform): HerdrVisualsApplication {
	return async (projection, action = "apply") => {
		if (herdrRemoteSession(env)) return { status: "unavailable", reason: "remote" };
		const target = localTarget(env, platform);
		if (!target) return { status: "unavailable" };
		const operation = () => createHerdrVisualsApplication({ configPath: target.configPath,
			...(platform === "win32" ? {
				replace: (before: string, after: string) => replaceWindowsHerdrConfig({ path: target.configPath, before, after }),
			} : {}),
			reload: () => new Promise<void>((done, reject) => {
				execFile(target.binary, ["server", "reload-config"], {
					env, timeout: 1500, maxBuffer: 4096, windowsHide: true,
				}, error => error ? reject(error) : done());
			}),
		})(projection, action);
		if (platform !== "win32") return operation();
		const pending = windowsApplication.then(operation, operation);
		windowsApplication = pending.then(() => undefined, () => undefined);
		return pending;
	};
}
