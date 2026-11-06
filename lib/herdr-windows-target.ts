import { win32 } from "node:path";

export interface WindowsHerdrTarget {
	configPath: string;
	binary: string;
}

/** Lexical checks only: the adapter must also reject nonlocal volumes and reparse points. */
function localPath(value: string): boolean {
	if (!/^[A-Za-z]:\\/.test(value) || win32.normalize(value) !== value) return false;
	return value.slice(3).split("\\").every(part => part.length > 0
		&& !/[<>:"/|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part)
		&& !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

/** Pure eligibility boundary; resolving a target never accesses files or IPC.
 * Socket values are Herdr filesystem-marker paths, not literal pipe names.
 * This is not executable attestation or proof of a running local server.
 */
export function resolveWindowsHerdrTarget(env: NodeJS.ProcessEnv): WindowsHerdrTarget | undefined {
	if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID?.trim() || !env.HERDR_SOCKET_PATH
		|| !localPath(env.HERDR_SOCKET_PATH) || env.GENTLE_PI_AGENTS_CHILD === "1"
		|| env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return undefined;
	const binary = env.HERDR_BIN_PATH ?? "herdr.exe";
	if (/^herdr-dev(?:\.exe)?$/i.test(win32.basename(binary))) return undefined;
	if (!/^(?:herdr|herdr\.exe)$/i.test(binary) && !localPath(binary)) return undefined;
	let configPath = env.HERDR_CONFIG_PATH;
	if (configPath === undefined) {
		if (!env.APPDATA || !localPath(env.APPDATA)) return undefined;
		configPath = win32.join(env.APPDATA, "herdr", "config.toml");
	}
	return localPath(configPath) ? { configPath, binary } : undefined;
}
