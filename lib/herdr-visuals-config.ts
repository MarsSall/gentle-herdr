import { createHash } from "node:crypto";
import { HERDR_NATIVE_THEMES } from "./herdr-native-themes.ts";
import type { projectHerdrTheme, projectHerdrTaskSummaryStyle } from "./herdr-theme-projection.ts";
import { planHerdrTaskSummaryConfig, type HerdrTaskSummaryConfigPlan } from "./herdr-task-summary-config.ts";

export interface HerdrVisualsProjection {
	theme: ReturnType<typeof projectHerdrTheme>;
	taskSummaryStyle: ReturnType<typeof projectHerdrTaskSummaryStyle>;
}
// Keep historical eight-, four- and twelve-token projections/stamps readable.
// Default now emits text colors plus the Gentleman.Dots fixed values for the
// active Gentle theme; working/done status and notification colors stay native.
// New keys are appended so historical stamped blocks keep their ascending order.
const LEGACY_TOKENS = ["sidebar_bg", "panel_bg", "active_row_bg", "selection_bg", "accent", "text", "red", "green"];
const TEXT_TOKENS = ["subtext0", "overlay0", "overlay1", "mauve", "yellow", "peach", "blue", "teal"];
const SURFACE_TOKENS = ["surface0", "surface1", "surface_dim"];
const TOKENS = [...LEGACY_TOKENS, ...TEXT_TOKENS, ...SURFACE_TOKENS];
const TEXT8 = ["accent", "text", "red", "green", "subtext0", "overlay0", "overlay1", "mauve"];
const CUSTOM_SETS = [LEGACY_TOKENS, ["accent", "text", "red", "green"], ["accent", "text", "red", "green", ...TEXT_TOKENS],
	TEXT8, [...TEXT8, "panel_bg"], [...TEXT8, "panel_bg", ...SURFACE_TOKENS],
	[...TEXT8, "panel_bg", ...SURFACE_TOKENS, "active_row_bg", "selection_bg"]];
// Historical projections used catppuccin; Default now uses the Gentleman.Dots base.
const CUSTOM_BASES = ["catppuccin", "one-dark"];
const TABLE = "ui.sidebar.agents.rows_by_agent";
const MARK = "# Gentle Shell Herdr visuals";
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const fail = (error: string): HerdrTaskSummaryConfigPlan => ({ ok: false, error });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function keys(value: unknown, required: string[], optional: string[] = []): boolean {
	return object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
}
function valid(value: unknown): value is HerdrVisualsProjection {
	if (!keys(value, ["theme", "taskSummaryStyle"])) return false;
	const p = value as HerdrVisualsProjection;
	if (!keys(p.theme, ["name"], ["custom"]) || !HERDR_NATIVE_THEMES.includes(p.theme.name)) return false;
	if (Object.hasOwn(p.theme, "custom") && (!CUSTOM_BASES.includes(p.theme.name) || !CUSTOM_SETS.some(set => keys(p.theme.custom, set)) || !Object.values(p.theme.custom!).every(color => typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)))) return false;
	return keys(p.taskSummaryStyle, ["fg", "dim", "bold"]) && typeof p.taskSummaryStyle.fg === "string" && HEX.test(p.taskSummaryStyle.fg) && typeof p.taskSummaryStyle.dim === "boolean" && typeof p.taskSummaryStyle.bold === "boolean";
}
/** Lexical safety only; the v1 recognizer still bounds the supported grammar.
 * Comments are not strings, and an escaped backslash cannot introduce a u escape.
 */
function safeLexemes(text: string): boolean {
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return false;
	for (const line of text.split(/\r?\n/)) {
		let quoted = false;
		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (!quoted && char === '#') break;
			if (quoted && char === '\\') {
				const escaped = line[++i];
				if (escaped === 'u') {
					const digits = line.slice(i + 1, i + 5);
					const scalar = /^[0-9a-fA-F]{4}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
					if (scalar >= 0xd800 && scalar <= 0xdfff) return false;
				}
			} else if (char === '"') quoted = !quoted;
		}
	}
	return true;
}

function summary(style: HerdrVisualsProjection["taskSummaryStyle"]): string {
	const token = (name: string) => `{ token = "${name}", fg = "${style.fg}", dim = ${style.dim}, bold = ${style.bold} }`;
	return `pi = [["state_icon", "machine", "workspace", "tab"], ["agent"], [${token("$summary")}], [${token("$summary2")}]]`;
}
type Kind = "name" | "custom" | "summary";
interface Piece { kind: Kind; payload: string }
function pieces(p: HerdrVisualsProjection): Piece[] {
	return [
		{ kind: "name", payload: `name = "${p.theme.name}"` },
		...(p.theme.custom ? [{ kind: "custom" as const, payload: TOKENS.filter(key => Object.hasOwn(p.theme.custom!, key)).map(key => `${key} = "${p.theme.custom![key as keyof typeof p.theme.custom]}"`).join("\n") }] : []),
		{ kind: "summary", payload: summary(p.taskSummaryStyle) },
	];
}
function target(kind: Kind): string { return kind === "name" ? "theme" : kind === "custom" ? "theme.custom" : TABLE; }

/** Insert at an existing table's end, or create it at EOF. No unowned byte is
 * serialized. Each insertion records whether it created a header/join newline.
 */
function render(original: string, additions: Piece[], eol: string): string {
	// Match supported indentation without consuming preceding line breaks.
	const headers = [...original.matchAll(/^[ \t]*\[([A-Za-z0-9_.-]+)\][ \t]*(?:#.*)?\r?$/gm)];
	const insertions = additions.map(piece => {
		const index = headers.findIndex(match => match[1] === target(piece.kind));
		return { ...piece, index, position: index < 0 ? original.length : (headers[index + 1]?.index ?? original.length) };
	}).sort((a, b) => a.position - b.position || Number(a.index < 0) - Number(b.index < 0));
	let text = "", cursor = 0;
	for (const { kind, payload, index, position } of insertions) {
		text += original.slice(cursor, position);
		cursor = position;
		const mode = index < 0 ? "created" : "existing";
		const join = text.length > 0 && !text.endsWith("\n") ? 1 : 0;
		const body = `${MARK} begin v2 ${kind} ${mode} join=${join}${eol}${index < 0 ? `[${target(kind)}]${eol}` : ""}${payload.replaceAll("\n", eol)}${eol}`;
		text += (join ? eol : "") + body + `${MARK} end v2 sha256=${digest(body)}${eol}`;
	}
	return text + original.slice(cursor);
}

/** Strip only intact bounded insertions. Canonical reconstruction below also
 * checks placement, header ownership and join restoration, not just the hash.
 */
function extract(text: string, eol: string): { original: string; additions: Piece[] } | undefined {
	const begins = [...text.matchAll(/^# Gentle Shell Herdr visuals begin v2 (name|custom|summary) (created|existing) join=([01])\r?$/gm)];
	let original = text;
	const additions: Piece[] = [];
	const seen = new Set<string>();
	for (const match of begins.reverse()) {
		const start = match.index!;
		const endStart = text.indexOf(`${MARK} end v2 sha256=`, start);
		const end = text.indexOf(eol, endStart);
		if (endStart < start || end < endStart || seen.has(match[1])) return;
		seen.add(match[1]);
		const body = text.slice(start, endStart);
		if (text.slice(endStart, end) !== `${MARK} end v2 sha256=${digest(body)}`) return;
		const kind = match[1] as Kind;
		const lines = body.split(eol).slice(1, -1);
		if (match[2] === "created" && lines.shift() !== `[${target(kind)}]`) return;
		const payload = lines.join("\n");
		if (kind === "name") {
			const name = /^name = "([a-z-]+)"$/.exec(payload)?.[1];
			if (!HERDR_NATIVE_THEMES.some(native => native === name)) return;
		}
		if (kind === "custom") {
			const indices = lines.map(line => TOKENS.findIndex(key => new RegExp(`^${key} = "#[0-9a-fA-F]{6}"$`).test(line)));
			if (!indices.length || indices.some((index, i) => index < 0 || (i > 0 && index <= indices[i - 1]))) return;
		}
		if (kind === "summary") {
			const styles = [...payload.matchAll(/fg = "(#[0-9a-fA-F]+)", dim = (true|false), bold = (true|false)/g)];
			if (styles.length !== 2 || !HEX.test(styles[0][1]) || payload !== summary({ fg: styles[0][1], dim: styles[0][2] === "true", bold: styles[0][3] === "true" })) return;
		}
		additions.push({ kind, payload });
		const cut = start - Number(match[3]) * eol.length;
		if (cut < 0 || (match[3] === "1" && text.slice(cut, start) !== eol)) return;
		original = original.slice(0, cut) + original.slice(end + eol.length);
	}
	if (original.includes(MARK)) return;
	additions.sort((a, b) => ["name", "custom", "summary"].indexOf(a.kind) - ["name", "custom", "summary"].indexOf(b.kind));
	if (render(original, additions, eol) !== text) return;
	return { original, additions };
}

interface RowAtom { start: number; end: number }
/** Locate only two-dimensional row arrays. Keep spans into the original text:
 * comments, whitespace and trailing commas are not tokens to rewrite. Inline
 * tables remain single-line, and escaped/literal strings stay unsupported.
 */
function rowLayout(source: string): { end: number; atoms: RowAtom[]; plain: string } | undefined {
	let position = 0;
	const atoms: RowAtom[] = [], rows: string[][] = [];
	function skip(): void {
		while (position < source.length) {
			if (/[ \t\r\n]/.test(source[position])) position++;
			else if (source[position] === '#') {
				while (position < source.length && source[position] !== '\n') position++;
			} else break;
		}
	}
	function take(char: string): boolean {
		skip();
		if (source[position] !== char) return false;
		position++;
		return true;
	}
	if (!take('[')) return;
	while (true) {
		if (!take('[')) return;
		const row: string[] = [];
		if (!take(']')) {
			while (true) {
				skip();
				const start = position;
				const atom = /^(?:"[^"\\\r\n]*"|\{[^{}\r\n]*\})/.exec(source.slice(position));
				if (!atom) return;
				position += atom[0].length;
				atoms.push({ start, end: position });
				row.push(atom[0].startsWith('{') ? '"agent"' : atom[0]);
				if (take(']')) break;
				if (!take(',')) return;
				if (take(']')) break;
			}
		}
		rows.push(row);
		if (take(']')) break;
		if (!take(',')) return;
		if (take(']')) break;
	}
	return { end: position, atoms, plain: `[${rows.map(row => `[${row.join(', ')}]`).join(', ')}]` };
}

interface Adoption { text: string; validation: string; name: boolean; custom: Set<string>; pi: boolean }
/** Recognize row arrays and four-field token styles without reserializing them.
 * The v1 scanner validates a string-only shadow; unrelated bytes stay intact.
 */
function adopt(original: string, p: HerdrVisualsProjection, apply: boolean): Adoption | undefined {
	let section = "", name = false, pi = false;
	const custom = new Set<string>();
	const lines: string[] = [], validation: string[] = [];
	const sourceLines = original.split(/(?<=\n)/);
	for (let index = 0; index < sourceLines.length; index++) {
		const line = sourceLines[index];
		const header = /^[ \t]*\[([A-Za-z0-9_.-]+)\]/.exec(line);
		if (header) section = header[1];
		let next = line, shadow = line;
		const assignment = /^([ \t]*)([A-Za-z0-9_-]+)([ \t]*=[ \t]*)(.*?)(\r?\n)?$/.exec(line);
		if (assignment) {
			const [, indent, key, equals, value, newline = ""] = assignment;
			if (section === "theme" && key === "name") {
				const match = /^"([a-z-]+)"([ \t]*(?:#.*)?)$/.exec(value);
				if (name || !match || !HERDR_NATIVE_THEMES.some(n => n === match[1])) return;
				name = true;
				if (apply) next = `${indent}${key}${equals}"${p.theme.name}"${match[2]}${newline}`;
			}
			if (section === "theme.custom" && TOKENS.includes(key)) {
				// User overrides are only detected, never rewritten, so any plain quoted
				// Herdr color (named, reset alias or hex) is a value to keep.
				const match = /^"[^"\\\r\n]*"([ \t]*(?:#.*)?)$/.exec(value);
				if (custom.has(key) || !match) return;
				// Like native Herdr themes, never rewrite a user override: custom
				// colors layer on top of any base. Only absent keys are contributed.
				custom.add(key);
			}
			if (section === TABLE && key === "pi" && !original.includes("# Gentle Shell task summary")) {
				if (pi) return;
				pi = true;
				const seen = new Set<string>();
				let invalid = false;
				const source = value + newline + sourceLines.slice(index + 1).join('');
				const layout = rowLayout(source);
				if (!layout) return;
				const tail = /^([ \t]*(?:#[^\r\n]*)?)(\r?\n|$)/.exec(source.slice(layout.end));
				if (!tail) return;
				const consumed = source.slice(0, layout.end + tail[0].length);
				// The validation shadow may unify LF/CRLF, but must not hide bare CR.
				if (/\r(?!\n)/.test(consumed)) return;
				index += (consumed.match(/\n/g)?.length ?? 0) - Number(consumed.endsWith('\n'));
				const rewrite = (item: string): string => {
					let token: string;
					const fields = new Map<string, string>();
					if (item.startsWith('"')) token = item.slice(1, -1);
					else {
						const body = item.slice(1, -1);
						for (const field of body.split(',')) {
							const match = /^[ \t]*(token|fg|dim|bold)[ \t]*=[ \t]*("[^"\\]*"|true|false)[ \t]*$/.exec(field);
							if (!match || fields.has(match[1])) { invalid = true; return item; }
							fields.set(match[1], match[2]);
						}
						if (!/^"[^"\\]+"$/.test(fields.get('token') ?? '') || (fields.has('fg') && !/^"#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?"$/.test(fields.get('fg')!)) || ['dim', 'bold'].some(k => fields.has(k) && !/^(true|false)$/.test(fields.get(k)!))) { invalid = true; return item; }
						token = fields.get('token')!.slice(1, -1);
					}
					if (!['$summary', '$summary2'].includes(token)) return item;
					if (seen.has(token)) invalid = true;
					seen.add(token);
					if (!apply) return item;
					if (item.startsWith('"')) return `{ token = "${token}", fg = "${p.taskSummaryStyle.fg}", dim = ${p.taskSummaryStyle.dim}, bold = ${p.taskSummaryStyle.bold} }`;
					let result = item;
					for (const key of ['fg', 'dim', 'bold'] as const) {
						const value = key === 'fg' ? `"${p.taskSummaryStyle.fg}"` : String(p.taskSummaryStyle[key]);
						if (fields.has(key)) result = result.replace(new RegExp(`(${key}[ \\t]*=[ \\t]*)("[^"\\\\]*"|true|false)`), `$1${value}`);
						else result = result.replace(/[ \t]*}$/, `, ${key} = ${value} }`);
					}
					return result;
				};
				const replacements = layout.atoms.map(atom => ({ ...atom, text: rewrite(source.slice(atom.start, atom.end)) }));
				if (invalid || seen.size !== 2) return;
				let rewritten = source.slice(0, layout.end);
				for (const atom of replacements.reverse()) rewritten = rewritten.slice(0, atom.start) + atom.text + rewritten.slice(atom.end);
				next = `${indent}${key}${equals}${rewritten}${tail[0]}`;
				// Validate the row grammar separately with v1 before removing its
				// ownership conflict from the full shadow. Other layout guards stay.
				const checked = planHerdrTaskSummaryConfig(`[other]\nx = ${layout.plain}\n`, { action: "remove", summaryColor: '#fff', continuationColor: '#fff' });
				if (!checked.ok) return;
				shadow = `${indent}# recognized Pi rows${newline}`;
			}
		}
		lines.push(next); validation.push(pi && section === TABLE && assignment?.[2] === 'pi' ? shadow : next);
	}
	return { text: lines.join(''), validation: validation.join(''), name, custom, pi };
}

/** Pure, bounded Herdr 0.9.3 proposal. No config access or activation. Existing
 * v1 layout ownership can be upgraded; recognized controlled fields can be adopted.
 * Hashes detect edits, not adversarial authentication. Unsupported TOML fails shut.
 */
export function planHerdrVisualsConfig(rawText: string, projection: HerdrVisualsProjection, action: "apply" | "remove" = "apply"): HerdrTaskSummaryConfigPlan {
	if (typeof rawText !== "string" || !valid(projection) || !["apply", "remove"].includes(action)) return fail("Invalid Herdr visuals projection; no changes proposed.");
	if (!safeLexemes(rawText)) return fail("Unsupported TOML control character or non-scalar escape; no changes proposed.");
	// Preserve intact stamp bytes even if neighboring unowned lines use another EOL.
	const eol = /^# Gentle Shell Herdr visuals begin v2 (?:name|custom|summary) (?:created|existing) join=[01](\r?\n)/m.exec(rawText)?.[1]
		?? (rawText.includes("\r\n") ? "\r\n" : "\n");
	const extracted = extract(rawText, eol);
	if (!extracted) return fail("Owned visuals block was changed or is ambiguous; no changes proposed.");
	const adoption = adopt(extracted.original, projection, action === "apply");
	if (!adoption) return fail("Unsupported or ambiguous controlled fields; no changes proposed.");
	if (extracted.additions.some(piece => (piece.kind === 'name' && adoption.name) || (piece.kind === 'custom' && piece.payload.split('\n').some(line => adoption.custom.has(line.split(' ')[0]))))) return fail("Mixed theme ownership; no changes proposed.");
	if (adoption.pi && extracted.additions.some(piece => piece.kind === 'summary')) return fail("Mixed layout ownership; no changes proposed.");
	// Normalize only the recognition shadow, never the proposed text or a legacy
	// ownership block whose stamp was computed over its exact original bytes.
	const validation = adoption.validation.includes("# Gentle Shell task summary")
		? adoption.validation : adoption.validation.replaceAll("\r\n", "\n");
	const legacy = planHerdrTaskSummaryConfig(validation, { action: "remove", summaryColor: "#fff", continuationColor: "#fff" });
	if (!legacy.ok) return legacy;
	if (legacy.changed && extracted.additions.length) return fail("Mixed legacy and visuals ownership; no changes proposed.");
	const original = legacy.changed ? legacy.text : adoption.text;
	// The old public recognizer checks duplicates, bounded values, Pi/default rows,
	// and all prospective layout ancestors, including during removal.
	let section = "";
	for (const line of original.split(/\r?\n/)) {
		const table = /^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/.exec(line);
		if (table) {
			section = table[1];
			if (section.startsWith("theme.") && section !== "theme.custom") return fail("Unowned theme layer; no changes proposed.");
			continue;
		}
		const assignment = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
		if (!assignment) continue;
		const key = assignment[1];
		if ((!section && key === "theme") || (section === "theme" && ["custom", "auto_switch", "dark_name", "light_name"].includes(key))) return fail("Unowned conflicting theme settings; no changes proposed.");
	}
	// Removal never adopts or rewrites an unowned field. Only intact stamps go.
	if (action === "remove") return { ok: true, text: original, changed: original !== rawText };
	const additions = pieces(projection).filter(piece => !(piece.kind === 'name' && adoption.name) && !(piece.kind === 'summary' && adoption.pi)).map(piece => piece.kind === 'custom' ? { ...piece, payload: piece.payload.split('\n').filter(line => !adoption.custom.has(line.split(' ')[0])).join('\n') } : piece).filter(piece => piece.payload);
	const text = render(original, additions, eol);
	return { ok: true, text, changed: text !== rawText };
}
