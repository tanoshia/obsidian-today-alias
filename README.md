# Hide Date Prefix — Obsidian Plugin

**Version 1.4.1**

Hides the leading date prefix from note titles in the **file explorer** while leaving the underlying filenames — and therefore all date-based sorting — completely intact. Works out of the box with Obsidian's default Daily Notes format (`YYYY-MM-DD`). This is a purely visual change; no files are ever renamed or modified.

## Features

- **Date prefix hiding** — strips the configured date prefix from the displayed title in the file explorer
- **[Moment.js format strings](https://momentjs.com/docs/#/displaying/format/)** — uses the same format system as Obsidian's own Templates and Templater plugins (`YYYY`, `MM`, `DD`, `HH`, `mm`, `Do`, `MMMM`, etc.); no regex required
- **Sort order preserved** — Obsidian sorts by the actual filename; only what you see changes
- **"Today" label** — a Daily Note whose filename matches today's date is shown with a configurable label (default `Today     -04`), updating automatically at midnight
- **Ignore patterns** — Moment.js format patterns to keep certain filenames fully untouched; bare Daily Notes and Meetings notes are pre-filled by default; `*` is supported as a wildcard
- **Custom ignore Today label** — ignored-pattern matches that start with today's date get their own configurable label prefix (default `Today's `)
- **Live preview** — every format field shows a real-time preview of how today's date renders with the current string
- **Live rename support** — display updates correctly on every filename rename, no lag or skipped updates
- **Auto-migration** — settings saved with the old `{TOKEN}` syntax are silently upgraded to Moment.js equivalents on first load
- **Clean unload** — all elements are restored to plain text when the plugin is disabled or unloaded

## Example

| Filename on disk | Shown in explorer |
|---|---|
| `2026-03-04` *(today, bare daily note)* | `Today     -04` |
| `2026-03-04 Meetings` *(today, ignored pattern)* | `Today's Meetings` |
| `2026-03-03 Meetings` *(ignored pattern, not today)* | `2026-03-03 Meetings` *(unchanged)* |
| `2026-03-03 M! Alice meeting email planning` | `M! Alice meeting email planning` |
| `2026-01-15 Project kickoff` | `Project kickoff` |
| `2026-02-03` *(bare daily note, ignored)* | `2026-02-03` *(unchanged)* |

## How it works

1. On load the plugin attaches a `MutationObserver` to the file-explorer container, watching for all DOM mutations (child additions, text swaps, character data changes).
2. A `vault.on('rename')` listener acts as a safety net to catch any edge cases the observer misses.
3. Whenever a `.nav-file-title-content` element is painted or updated:
   - If the filename exactly equals today's date and **Show Today label** is on → replaced with the configured label (e.g. `Today     -04`)
   - If the filename matches any **ignore pattern** and **Show Today label for ignore matches** is on and it starts with today's date → replaced with the configured prefix label + the rest of the filename
   - If the filename matches any **ignore pattern** otherwise → left completely untouched
   - Otherwise the date prefix is wrapped in a hidden `<span class="hdp-date">` and the rest shown in `<span class="hdp-rest">`
4. A midnight timeout fires each night to refresh the Today label for the new date automatically.
5. On unload every element is restored to its original plain-text form; no trace is left behind.

## Format reference

All format fields use **[Moment.js format strings](https://momentjs.com/docs/#/displaying/format/)** — the same system Obsidian's own Templates and Templater plugins use.

| Token | Meaning | Example |
|---|---|---|
| `YYYY` | 4-digit year | `2026` |
| `MM` | 2-digit month | `03` |
| `DD` | 2-digit day | `04` |
| `Do` | Day with ordinal | `4th` |
| `MMMM` | Full month name | `March` |
| `HH` | 24-hour hour | `14` |
| `mm` | Minutes | `05` |
| `[text]` | Literal (escaped) text | `[Today -]` |

Full reference: [momentjs.com/docs/#/displaying/format/](https://momentjs.com/docs/#/displaying/format/)

## Settings

Wrap literal text in square brackets to prevent it being treated as a token (e.g. `[Today -]DD`).

| Setting | Default | Description |
|---|---|---|
| **Enable** | `true` | Toggle date-prefix hiding without uninstalling. |
| **Date format** | `YYYY-MM-DD` | Moment.js format of the date prefix at the start of filenames. Matches Obsidian's default Daily Notes format. Example for full datetime: `YYYY-MM-DD[T]HH[:]mm[:]ss[Z]`. |
| **Patterns to ignore** | `YYYY-MM-DD` / `YYYY-MM-DD [Meetings]` | One Moment.js pattern per line matched against the full filename. Files that match are left untouched. Use `*` as a wildcard and `[...]` to escape literal words — e.g. `YYYY-MM-DD [Meetings]` (without brackets, `M` would be parsed as a month token). Remove `YYYY-MM-DD` to let the plugin hide the date on bare daily notes (leaving them blank in the explorer). |
| **Show "Today" label for daily note** | `true` | Replaces a bare today-dated Daily Note with the label below. Updates at midnight. |
| **→ Label format** | `[Today     -]DD` | Moment.js format for the Today label. Wrap literal text in `[...]`. |
| **Show "Today" label for pattern ignore matches** | `true` | Also applies a Today prefix to ignored-pattern files that start with today's date. |
| **→ Label format** | `[Today's ]` | Moment.js format for the prefix. The rest of the filename is appended after. |

## Installation (manual / development)

```bash
cd ~/MiscCode/obsidian-hide-date-prefix
npm install
npm run build          # produces main.js
```

Copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin folder:

```
<your vault>/.obsidian/plugins/hide-date-prefix/
```

Reload Obsidian (**Ctrl/Cmd+R** in developer mode, or close and reopen), then go to **Settings → Community plugins** and enable **Hide Date Prefix**.

## Upgrading from v1.3.x

Settings using the old `{YYYY}-{MM}-{DD}` token syntax are automatically migrated to Moment.js equivalents on first load — no manual action needed.

## Why not rename the files?

Renaming would break internal links and require vault reorganisation. This plugin is **purely visual** — filenames, links, frontmatter and every other Obsidian feature are never touched.

## Next Up

Renaming affected tabs too (consistency)