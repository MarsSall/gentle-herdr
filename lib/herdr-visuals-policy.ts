import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { HERDR_NATIVE_THEMES, type HerdrNativeTheme, type HerdrVisualsThemeChoice } from "./herdr-native-themes.ts";

export const HERDR_SUMMARY_COLORS = ["accent", "text", "muted", "dim", "success", "warning", "error"] as const;
export type HerdrSummaryColor = typeof HERDR_SUMMARY_COLORS[number];
export interface HerdrVisualsOptions { agentDir?: string }
export type HerdrMachineTheme = "same" | HerdrVisualsThemeChoice;
export interface HerdrVisualsSettings {
	theme: HerdrVisualsThemeChoice;
	summaryColor: "default" | HerdrSummaryColor;
	/** Omitted by legacy callers; persisted v2 records always include this map. */
	machines?: Record<string, { theme: HerdrMachineTheme }>;
}
export const HERDR_VISUALS_SCHEMA = "gentle-herdr.preferences/v2";
export const DEFAULT_HERDR_VISUALS_SETTINGS: HerdrVisualsSettings = { theme: "default", summaryColor: "default", machines: {} };
export interface HerdrVisualsResolution {
	settings: HerdrVisualsSettings;
	globalFile: string;
	source: "global_file" | "default";
	malformed: boolean;
	readError: boolean;
}

export function isHerdrVisualsSettings(value: unknown): value is HerdrVisualsSettings {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const settings = value as Record<string, unknown>;
	return Object.keys(settings).every(key => ["theme", "summaryColor", "machines"].includes(key)) && Object.hasOwn(settings, "theme")
		&& Object.hasOwn(settings, "summaryColor")
		&& (settings.theme === "default" || HERDR_NATIVE_THEMES.includes(settings.theme as HerdrNativeTheme))
		&& (settings.summaryColor === "default" || HERDR_SUMMARY_COLORS.includes(settings.summaryColor as HerdrSummaryColor))
		&& (!Object.hasOwn(settings, "machines") || validMachines(settings.machines));
}
function validMachines(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& Object.entries(value).every(([id, entry]) => id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(id)
			&& typeof entry === "object" && entry !== null && !Array.isArray(entry) && Object.keys(entry).length === 1
			&& Object.hasOwn(entry, "theme") && (entry.theme === "same" || entry.theme === "default"
				|| HERDR_NATIVE_THEMES.includes(entry.theme as HerdrNativeTheme)));
}

/** Read only this package's store; Gentle Shell preferences are never consulted. */
export function resolveHerdrVisualsSettings(options: HerdrVisualsOptions = {}): HerdrVisualsResolution {
	const globalFile = join(resolve(options.agentDir ?? getAgentDir()), "gentle-herdr.json");
	const fallback: HerdrVisualsResolution = {
		settings: { ...DEFAULT_HERDR_VISUALS_SETTINGS, machines: {} },
		globalFile, source: "default", malformed: false, readError: false,
	};
	let fd: number | undefined;
	try {
		// Bounded, nonblocking reads reject nonregular and oversized stores.
		fd = openSync(globalFile, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 4096) throw new Error("Unsupported Herdr preferences file");
		const buffer = Buffer.alloc(4097);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		if (length > 4096) throw new Error("Oversized Herdr preferences file");
		let settings: HerdrVisualsSettings | undefined;
		try {
			const value: unknown = JSON.parse(buffer.toString("utf8", 0, length));
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				const { schema, ...candidate } = value as Record<string, unknown>;
				const legacy = schema === "gentle-herdr.preferences/v1" && !Object.hasOwn(candidate, "machines");
				if ((legacy || schema === HERDR_VISUALS_SCHEMA && Object.hasOwn(candidate, "machines")) && isHerdrVisualsSettings(candidate))
					settings = { ...candidate, machines: candidate.machines ?? {} };
			}
		} catch { /* Invalid JSON is malformed, not a read failure. */ }
		return { ...fallback, source: "global_file", malformed: !settings,
			settings: settings ?? { ...DEFAULT_HERDR_VISUALS_SETTINGS, machines: {} } };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return missing ? fallback : { ...fallback, source: "global_file", readError: true };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Validate first; never overwrite an unhealthy package store. */
export function writeHerdrVisualsSettings(settings: HerdrVisualsSettings, options: HerdrVisualsOptions = {}): string {
	if (!isHerdrVisualsSettings(settings)) throw new TypeError("Invalid Herdr visuals settings");
	const serialized = `${JSON.stringify({ schema: HERDR_VISUALS_SCHEMA, ...settings, machines: settings.machines ?? {} })}\n`;
	if (Buffer.byteLength(serialized) > 4096) throw new Error("Oversized Herdr preferences file");
	const current = resolveHerdrVisualsSettings(options);
	if (current.malformed || current.readError) throw new Error("Refusing to overwrite unreadable or malformed Herdr settings");
	const path = current.globalFile;
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(resolve(path, ".."), { recursive: true });
	let written = false;
	try {
		writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
		written = true;
		renameSync(temporary, path);
	} catch (error) {
		// An exclusive-open collision belongs to another writer, not this attempt.
		const collision = !written && typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
		// Cleanup is best effort and must never mask the original failure.
		if (!collision) try { rmSync(temporary, { force: true }); } catch { /* keep the original error */ }
		throw error;
	}
	return path;
}
