# gentle-herdr

Herdr visuals for Gentle Shell users: choose a native Herdr theme or follow your live Pi palette, and style the task-summary rows. This standalone Pi package adds **`/gentle:herdr`**; it does not require a change to Gentle Shell.

## Install and use

```sh
pi install git:github.com/MarsSall/gentle-herdr
```

In an interactive Pi terminal running inside a supported local Herdr pane, run `/gentle:herdr`:

- **Theme** — Default follows your active Gentle Shell theme (named in the menu), plus every supported native Herdr theme; the current preference is marked.
- **Summary color** — Default or accent, text, muted, dim, success, warning, error.
- **Apply now** — apply the saved preferences again.
- **Remove from Herdr config** — remove package-owned blocks without deleting preferences.
- **Close** — leave without changes.

Theme and Summary color lists update a preview as you move the highlight with Up/Down. Default shows a mock sidebar using the live Gentle Shell projection, including secondary text and both summary rows; summary colors preview both rows. Native themes describe Herdr's built-in theme by name, without invented palette colors; summary previews for native themes use the terminal default background. The preview is illustrative: Herdr's native status colors and your custom overrides may differ. Enter opens confirmation; Esc cancels. Older hosts without custom UI fall back to a standard list and confirmation preview. Highlighting never saves or applies. Confirmation saves the preference **first**, then applies it locally. A changed config requests `herdr server reload-config`; the notice distinguishes requested, unchanged, unavailable, config failure and reload failure. “Reload requested” is not proof that the client rendered the result.

Preferences live in `gentle-herdr.json` inside Pi's SDK `getAgentDir()` directory. Malformed or unreadable preferences are refused, not overwritten. Opening the menu or cancelling a preview writes nothing.

## What changes in Herdr

The package edits only Gentle-owned, hash-stamped blocks and recognized `theme.name` and `$summary`/`$summary2` styles. Applying ensures both summary rows exist. It preserves other rows, comments, ordering and original line endings, and refuses ambiguous or unsupported TOML without writing.

**User `[theme.custom]` colors are never rewritten**, including hex, named and `reset` values. Herdr layers these over the selected base, so your overrides can change the visible result. Package-owned projection blocks are separate from user custom colors.

Default uses the `one-dark` base, projects live Gentle text colors (including sidebar secondary text), and adds the Gentleman.Dots profile values absent from the Pi palette. Cute/Sexy use the profile's black panel and surfaces; Sexy also gets fuchsia sidebar text, grayish pink detail text and a wine active row, so it looks different from Cute. Neutral Gentle uses its panel color. Status and notification colors stay native. Default summary color follows Pi's accent with dim styling, including when a native Herdr theme is selected.

While Theme is **Default**, a lightweight watcher checks the active Pi theme every 500 ms and re-applies once per observed name/palette change, using the same local-client guards. It never applies merely on session startup, never retries an unchanged theme, and stops at session shutdown. Native Theme choices disable automatic re-apply, even with Default summary color; use Apply now to refresh that color.

## Local, SSH and Windows

Herdr reads theme and sidebar from the **client machine's own config**, even when viewing an SSH machine. Remote menus explain this before confirmation: preferences can be saved there, but nothing is applied from that machine. Run `/gentle:herdr` locally on the client instead. Child sessions and known `herdr-dev` binaries are also refused before config access; the watcher is not registered in child sessions.

Supported targets are local Linux and Windows Herdr panes. Linux uses `$XDG_CONFIG_HOME/herdr/config.toml` or `$HOME/.config/herdr/config.toml`. Windows uses `%APPDATA%\herdr\config.toml`. `HERDR_CONFIG_PATH` can select an explicit supported local path. The config must already exist; the package does not bootstrap it.

Windows writes use a fixed PowerShell helper, protected staging on NTFS, and `File.Replace`, with original-file recovery on replacement failure. Config errors do not request reload. Reload errors leave committed config in place and report unknown client state rather than claiming success.

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
