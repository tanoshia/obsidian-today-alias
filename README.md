# Hide Date Prefix — Obsidian Plugin

**Version 1.2.0**

Hides the leading `YYYY-MM-DD` date from note titles in the **file explorer** while leaving the underlying filenames — and therefore all date-based sorting — completely intact. This is a purely visual change; no files are ever renamed or modified.

## Features

- **Date prefix hiding** — strips `YYYY-MM-DD` from the displayed title in the file explorer
- **Sort order preserved** — Obsidian sorts by the actual filename; only what you see changes
- **"Today" label** — a Daily Note whose filename is exactly today's date (e.g. `2026-03-03`) is shown as `Today     -03` instead of the raw date, updating automatically at midnight
- **Ignore patterns** — configurable regex list to keep certain filenames fully untouched (bare Daily Notes are ignored by default)
- **Live rename support** — display updates correctly on every filename rename, no lag or skipped updates
- **Clean unload** — all elements are restored to plain text when the plugin is disabled or unloaded

## Example

| Filename on disk | Shown in explorer |
|---|---|
| `2026-03-03` *(today)* | `Today     -03` |
| `2026-03-02 M! Alice meeting email planning` | `M! Alice meeting email planning` |
| `2026-01-15 Project kickoff` | `Project kickoff` |
| `2025-12-31 Year-end review` | `Year-end review` |
| `2026-02-03` *(bare daily note, ignored)* | `2026-02-03` *(unchanged)* |

## How it works

1. On load the plugin attaches a `MutationObserver` to the file-explorer container, watching for all DOM mutations (child additions, text swaps, character data changes).
2. A `vault.on('rename')` listener acts as a safety net to catch any edge cases the observer misses.
3. Whenever a `.nav-file-title-content` element is painted or updated:
   - If the filename is exactly today's date and the **Today label** setting is on → replaced with `Today     -DD`
   - If the filename matches any **ignore pattern** → left completely untouched
   - Otherwise the date prefix is wrapped in a hidden `<span class="hdp-date">` and the rest shown in `<span class="hdp-rest">`
4. A midnight timeout fires each night to refresh the Today label for the new date automatically.
5. On unload every element is restored to its original plain-text form; no trace is left behind.

## Settings

| Setting | Default | Description |
|---|---|---|
| **Enable** | `true` | Toggle date-prefix hiding without uninstalling. |
| **Date pattern (regex)** | `^(\d{4}-\d{2}-\d{2})\s*` | Regex matched from the start of each filename. Change for different date formats (e.g. `^(\d{8})\s*` for `20260302`). |
| **Ignore patterns** | `^\d{4}-\d{2}-\d{2}$` | One regex per line. If the full filename matches, it is left untouched. Add extra lines to ignore additional patterns (e.g. `^\d{4}-\d{2}-\d{2}\s+Meetings?$`), (e.g. ^\d{4}-\d{2}-\d{2}\s+) |
| **Show "Today" label** | `true` | Replaces a bare today-dated Daily Note with `Today     -DD`. Updates at midnight. |

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

## Why not rename the files?

Renaming would break internal links and require vault reorganisation. It avoids breaking anything if the plugin fails for any reason. This plugin is **purely visual** — filenames, links, frontmatter and every other Obsidian feature are never touched.
