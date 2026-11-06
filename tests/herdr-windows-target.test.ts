import assert from "node:assert/strict";
import test from "node:test";
import { resolveWindowsHerdrTarget } from "../lib/herdr-windows-target.ts";

const pane = { HERDR_ENV: "1", HERDR_PANE_ID: "fixture", HERDR_SOCKET_PATH: String.raw`C:\fixture\server.sock`, APPDATA: String.raw`C:\fixture\Roaming` };
test("Windows resolves APPDATA and explicit config without mutating its environment", () => {
	for (const override of [undefined, String.raw`D:\fixture\custom.toml`]) {
		const env = Object.freeze({ ...pane, ...(override ? { HERDR_CONFIG_PATH: override } : {}) });
		assert.deepEqual(resolveWindowsHerdrTarget(env), { configPath: override ?? String.raw`C:\fixture\Roaming\herdr\config.toml`, binary: "herdr.exe" });
	}
});
test("Windows rejects missing pane markers, SSH and child contexts", () => {
	for (const extra of [{ HERDR_ENV: "0" }, { HERDR_PANE_ID: " " }, { HERDR_SOCKET_PATH: "" }, { SSH_CONNECTION: "remote" }, { SSH_CLIENT: "remote" }, { SSH_TTY: "remote" }, { GENTLE_PI_AGENTS_CHILD: "1" }]) {
		assert.equal(resolveWindowsHerdrTarget({ ...pane, ...extra }), undefined);
	}
});
test("Windows rejects ambiguous and remote config paths without HOME fallback", () => {
	for (const path of ["", " ", "relative.toml", "C:relative.toml", String.raw`\rooted.toml`, String.raw`\\server\share\config.toml`, String.raw`\\?\C:\config.toml`, String.raw`C:\config.toml:stream`, String.raw`C:\a\..\config.toml`, String.raw`C:\a.\config.toml`, String.raw`C:\NUL\config.toml`]) {
		assert.equal(resolveWindowsHerdrTarget({ ...pane, HERDR_CONFIG_PATH: path }), undefined, path);
	}
	assert.equal(resolveWindowsHerdrTarget({ ...pane, APPDATA: "", HOME: String.raw`C:\fixture` }), undefined);
});
test("Windows refuses known debug executable spellings", () => {
	for (const binary of ["herdr-dev", "herdr-dev.exe", "HERDR-DEV.EXE", String.raw`C:\fixture\Herdr-Dev.exe`]) {
		assert.equal(resolveWindowsHerdrTarget({ ...pane, HERDR_BIN_PATH: binary }), undefined, binary);
	}
	assert.deepEqual(resolveWindowsHerdrTarget({ ...pane, HERDR_BIN_PATH: String.raw`C:\Program Files\Herdr\herdr.exe` }), { configPath: String.raw`C:\fixture\Roaming\herdr\config.toml`, binary: String.raw`C:\Program Files\Herdr\herdr.exe` });
});

test("Windows rejects superscript reserved devices in every path role", () => {
	for (const name of ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"]) {
		for (const suffix of ["", ".toml"]) {
			const path = `C:\\fixture\\${name}${suffix}`;
			for (const key of ["HERDR_SOCKET_PATH", "HERDR_CONFIG_PATH", "APPDATA", "HERDR_BIN_PATH"]) {
				assert.equal(resolveWindowsHerdrTarget({ ...pane, [key]: path }), undefined, `${key}: ${path}`);
			}
		}
	}
});
