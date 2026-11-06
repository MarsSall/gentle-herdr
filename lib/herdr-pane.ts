/** Copied from Gentleman-Programming/gentle-shell lib/herdr-activity.ts.
 * Detection only: this package never publishes activity or controls visibility.
 */
export function herdrDetected(env: NodeJS.ProcessEnv): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID?.trim() && !!env.HERDR_SOCKET_PATH?.trim();
}
