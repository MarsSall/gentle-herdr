# gentle-herdr

Herdr visuals for Gentle Shell users: choose a native Herdr theme or follow your live Pi palette, and style the task-summary rows. This standalone Pi package adds **`/gentle:herdr`**; it does not require a change to Gentle Shell.

## Install and use

```sh
pi install git:github.com/MarsSall/gentle-herdr
```

In an interactive Pi terminal running inside a supported local Herdr pane, run `/gentle:herdr`:

- **Theme** — Default follows your active Gentle Shell theme (named in the menu), plus every supported native Herdr theme; the current preference is marked.
- **Summary color** — Default or accent, text, muted, dim, success, warning, error.
- **Machines** — choose a theme for each enabled saved Herdr machine: **Same as this computer** (the default), **Default**, or a native theme, with the current choice marked and the same preview as Theme.
- **Apply now** — apply the saved preferences locally first, then to each enabled saved machine.
- **Remove from Herdr config** — remove package-owned blocks without deleting preferences.
- **Close** — leave without changes.

Theme and Summary color lists update a preview as you move the highlight with Up/Down. Default shows a mock sidebar using the live Gentle Shell projection, including secondary text and both summary rows; summary colors preview both rows. Native themes describe Herdr's built-in theme by name, without invented palette colors; summary previews for native themes use the terminal default background. The preview is illustrative: Herdr's native status colors and your custom overrides may differ. Enter opens confirmation; Esc cancels. Older hosts without custom UI fall back to a standard list and confirmation preview. Highlighting never saves or applies. Confirmation saves the preference **first**, then applies it locally and to enabled saved machines. A changed config requests `herdr server reload-config`; the notice distinguishes requested, unchanged, unavailable, config failure and reload failure. “Reload requested” is not proof that the client rendered the result.

Preferences live in `gentle-herdr.json` inside Pi's SDK `getAgentDir()` directory. Writes use schema v2 with a per-machine theme map keyed by saved machine ID; v1 stores still load, treating every machine as **Same as this computer**. Reads and writes are bounded to 4 KiB; an oversized preference map is refused before writing. Malformed or unreadable preferences are refused, not overwritten. Opening the menu or cancelling a preview writes nothing.

## What changes in Herdr

The package edits only Gentle-owned, hash-stamped blocks and recognized `theme.name` and `$summary`/`$summary2` styles. Applying ensures both summary rows exist. It preserves other rows, comments, ordering and original line endings, and refuses ambiguous or unsupported TOML without writing.

**User `[theme.custom]` colors are never rewritten**, including hex, named and `reset` values. Herdr layers these over the selected base, so your overrides can change the visible result. Package-owned projection blocks are separate from user custom colors.

Default uses the `one-dark` base, projects live Gentle text colors (including sidebar secondary text), and adds the Gentleman.Dots profile values absent from the Pi palette. Cute/Sexy use the profile's black panel and surfaces; Sexy also gets fuchsia session names, grayish pink branches and a wine active row, so it looks different from Cute. Neutral Gentle uses its panel color. Status and notification colors stay native. Default summary color follows Pi's accent with dim styling, including when a native Herdr theme is selected.

While Theme is **Default**, a lightweight watcher checks the active Pi theme every 500 ms and re-applies once per observed name/palette change, using the same local-client guards. It never applies merely on session startup, never retries an unchanged theme, and stops at session shutdown. Native Theme choices disable local automatic re-apply, even with Default summary color; use Apply now to refresh that color. Saved machines whose effective theme is Default also re-apply on a palette change, even if this computer uses a native theme. Each change produces at most one notice, including any per-machine failures.

## Local, SSH and Windows

Herdr reads theme and sidebar from the **client machine's own config**, even when viewing an SSH machine. Pane borders, however, come from the server machine's config. Remote menus explain this before confirmation: preferences can be saved there, but nothing is applied from that machine. To configure that machine's pane borders, run `/gentle:herdr` → **Machines** on the client instead. Child sessions and known `herdr-dev` binaries are also refused before config access; the watcher is not registered in child sessions.

Supported targets are local Linux and Windows Herdr panes. Linux uses `$XDG_CONFIG_HOME/herdr/config.toml` or `$HOME/.config/herdr/config.toml`. Windows uses `%APPDATA%\herdr\config.toml`. `HERDR_CONFIG_PATH` can select an explicit supported local path. The config must already exist; the package does not bootstrap it.

Windows writes use a fixed PowerShell helper, protected staging on NTFS, and `File.Replace`, with original-file recovery on replacement failure. Config errors do not request reload. Reload errors leave committed config in place and report unknown client state rather than claiming success.

## Saved machines over SSH

On the local client, open **Machines**, choose an enabled saved machine, and confirm its theme. Applying from Theme, Summary color, Machines, or Apply now updates this computer first, then each enabled saved machine. **Same as this computer** follows this computer's saved theme choice; a machine's **Default** follows the client's live Gentle Shell palette. The saved summary color is shared. Results are reported per machine; one failure does not stop the others or undo a local apply.

Requirements:

- A saved machine visible in `herdr machine list --json`, with key-based SSH and an already trusted host key. SSH uses `BatchMode=yes` and a 10-second connection timeout; it never asks for passwords or host-key approval.
- A Linux, Darwin or *BSD remote (`uname -s` is checked), with `sh`, `sha256sum`, `head -c`, `mktemp`, hard links, standard file utilities, and GNU or BSD `stat`. All other platforms, including Windows with MINGW/MSYS/Cygwin POSIX tools, are refused with a dedicated unsupported status (local Windows remains supported).
- Permission to read the config and create/rename files in its directory. Remote commands have a bounded wall time; config content is limited to 256 KiB.

The remote resolves `$HERDR_CONFIG_PATH`, otherwise `${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml`. A missing remote config is treated as empty and may be created (unlike local configs). Content and the expected SHA-256 travel only over SSH stdin, never as command-line values. Planning runs on the client with the same ownership/TOML safeguards: only stamped blocks, recognized theme name and summary styles change; user custom colors remain untouched.

Writes stage privately beside the remote config and preserve an existing file's mode (new files are 0600). The current config is atomically moved to a private sibling backup (or noted absent), then that copy's SHA-256/expected absence is verified. A mismatch reports **conflict** and restores the original with a no-overwrite hard link. Commit also uses a no-overwrite hard link from staging to the config path: if another file appeared, it stays untouched, no reload is requested, and the original remains beside it as `config.toml.gentle-herdr.backup.<nonce>` (using the actual config basename). The structured conflict result reports only the backup basename, never its full path. Successful writes remove the backup and staging names. An existing package lock also reports conflict. Re-open/apply after resolving the conflict; there is no automatic retry. A fixed `committed` acknowledgement requests `herdr --machine <label> server reload-config` even if the write process subsequently exits nonzero. **reload-failed** means the remote config was updated but the reload was not confirmed; **auth**, **unreachable**, **unsupported**, and **invalid-config** are isolated to that machine. Notices never include remote config contents or raw SSH errors.

Limitations: this is not a transaction across machines. The config path is briefly absent between moving the original aside and linking the staged file (or restoring the original). The lock serializes this package's writers, not unrelated editors: a writer still holding the old file open can write in place after the hash check; those later bytes are not guaranteed to reach the committed config. Avoid concurrent in-place editing. HUP/INT/TERM handlers clean staging/locks, restore without overwriting, and exit with 128+signal; SIGKILL, host failure, or a lost SSH acknowledgement can still leave staging/lock/backup names or an unacknowledged committed write requiring manual inspection (no automatic retry). On conflict, any external file at the config path is kept, and a displaced original that cannot be restored without overwriting is retained as a clearly named sibling backup; only its basename is reported. Removal below affects this computer only; remote blocks are not removed automatically. Native previews do not fetch remote palettes, and user overrides can change the visible result.

## Remove and uninstall

1. On the local client, choose **Remove from Herdr config** and confirm. Only intact package-owned blocks are removed; adopted user settings remain. Edited or ambiguous owned blocks fail closed rather than guessing what to remove.
2. Uninstall the Pi package:

   ```sh
   pi remove git:github.com/MarsSall/gentle-herdr
   ```

Uninstalling alone does not undo Herdr config edits. The package preference file is retained; removing config blocks does not reset it, and later Apply now or a Default theme change can apply the saved styling again while the extension remains active.

## Relationship to Gentle Shell

Gentle Shell owns the task-summary **text and on/off setting**: `/gentle:customize` → **Layout**. This package only styles Herdr. It never publishes activity, writes `herdr-task-summary.json`, or offers a task-summary visibility toggle. Summary rows can therefore be styled even when Gentle Shell's publisher is off.

## Development

Requires Node.js 22+ and the Pi host peer packages. Run `npm test` and `npm run typecheck`. Tests use controlled fixtures and application stubs, not your real Herdr config or binary. Windows/NTFS replacement checks require Windows; live rendering and reload behavior should also be checked with a real Pi/Herdr client.

## License

[MIT](LICENSE). Based on the original Gentle Shell Herdr visuals contribution; see the license for attribution.
