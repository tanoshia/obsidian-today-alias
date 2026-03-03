# Hide Date Prefix — Obsidian Plugin

Hides the leading `YYYY-MM-DD` date from note titles in the **file explorer** while leaving the underlying filename (and therefore all date-based sorting) completely intact.

## Example

| Filename on disk | Shown in explorer |
|---|---|
| `2026-03-02 M! Alice meeting email planning` | `M! Alice meeting email planning` |
| `2026-01-15 Project kickoff` | `Project kickoff` |
| `2025-12-31 Year-end review` | `Year-end review` |

Notes are still **sorted by date** because Obsidian sorts by the actual filename — only the visual label changes.

## How it works

1. On load the plugin registers a `MutationObserver` on the file-explorer container.
2. Whenever a `.nav-file-title-content` DOM element is painted (initial render, scroll, folder expand, vault change) its text is split at the date boundary:
   - `<span class="hdp-date">2026-03-02 </span>` — hidden via `display: none`
   - `<span class="hdp-rest">M! Alice meeting email planning</span>` — shown normally
3. On unload every element is restored to plain text; no trace is left behind.

## Settings

| Setting | Default | Description |
|---|---|---|
| **Enable** | `true` | Toggle date-prefix hiding without uninstalling the plugin. |
| **Date pattern (regex)** | `^(\d{4}-\d{2}-\d{2})\s*` | Regex matched from the start of each filename. Change this for different date formats (e.g. `^(\d{8})\s*` for `20260302`). |

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

Renaming would break internal links and require vault reorganisation. This plugin is **purely visual** — filenames, links, frontmatter and every other Obsidian feature are never touched.
