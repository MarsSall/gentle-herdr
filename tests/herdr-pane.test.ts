import assert from "node:assert/strict";
import test from "node:test";
import { herdrDetected } from "../lib/herdr-pane.ts";

test("pane detection requires the marker and nonblank pane/socket values", () => {
	const pane = { HERDR_ENV: "1", HERDR_PANE_ID: "pane", HERDR_SOCKET_PATH: "socket" };
	assert.equal(herdrDetected(pane), true);
	for (const env of [{}, { ...pane, HERDR_ENV: "0" }, { ...pane, HERDR_PANE_ID: " " }, { ...pane, HERDR_SOCKET_PATH: "\t" }]) {
		assert.equal(herdrDetected(env), false);
	}
});
