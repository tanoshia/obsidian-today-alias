import { App, Plugin, PluginSettingTab, Setting, TextComponent, moment } from 'obsidian';
import { TodayAliasSettings, DEFAULT_SETTINGS } from './settings';

export default class TodayAliasPlugin extends Plugin {
	settings: TodayAliasSettings;
	private observer: MutationObserver | null = null;
	private tabObserver: MutationObserver | null = null;
	/** Tracks alias replacements made on tab-title elements so they can be cleanly restored. */
	private tabAliasMap = new WeakMap<HTMLElement, { original: string; alias: string }>();
	/** CSS selectors for the two tab-title locations Obsidian renders. */
	private static readonly TAB_SELECTORS = '.view-header-title, .workspace-tab-header-inner-title';
	/** Fixed-format (YYYY-MM-DD) date string for the last known day; used to detect rollovers. */
	private lastKnownDay = '';

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TodayAliasSettingTab(this.app, this));

		// Snapshot the current day so checkDateChange() can detect rollovers
		this.lastKnownDay = moment().format('YYYY-MM-DD');

		this.app.workspace.onLayoutReady(() => {
			this.startObserver();
		});

		// ── Day-rollover detection ─────────────────────────────────────────────
		// The midnight setTimeout is unreliable when the system sleeps, so we
		// supplement it with a window focus listener and a 60-second interval.

		// 1. Fires when the user switches back to Obsidian (or the system wakes).
		const onFocus = () => this.checkDateChange();
		window.addEventListener('focus', onFocus);
		this.register(() => window.removeEventListener('focus', onFocus));

		// 2. Polling fallback for windows left open without regaining focus.
		const intervalId = window.setInterval(() => this.checkDateChange(), 60_000);
		this.register(() => window.clearInterval(intervalId));

		// 3. Precise midnight trigger for when the app stays active all night.
		this.scheduleMidnightRefresh();

		// Re-process after any vault rename so the explorer and tabs always
		// reflect the latest filename immediately.
		this.registerEvent(this.app.vault.on('rename', () => {
			if (!this.settings.enabled) return;
			setTimeout(() => {
				document
					.querySelectorAll<HTMLElement>('.nav-file-title-content')
					.forEach((el) => this.processItem(el));
				this.refreshTabs();
			}, 50);
		}));

		// Re-label tabs whenever Obsidian switches the active leaf or rearranges
		// the layout (e.g. opening a new tab, moving a pane).
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				if (!this.settings.enabled) return;
				setTimeout(() => this.refreshTabs(), 50);
			})
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (!this.settings.enabled) return;
				setTimeout(() => this.refreshTabs(), 50);
			})
		);
	}

	onunload() {
		this.stopObserver();
		this.restoreAllItems();
		this.restoreAllTabs();
	}

	async loadSettings() {
		const loaded = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

		// ── Migrate pre-1.4.0 settings ({TOKEN} style → Moment.js style) ───────
		if (!loaded?.settingsVersion) {
			// Convert {TOKEN} patterns to Moment.js, wrapping literal segments in
			// [...] so stray letters (e.g. the 'M' in 'Meetings') are never
			// mistaken for Moment.js tokens by momentFmtToRegexStr.
			const migratePattern = (fmt: string): string => {
				const tokenMap: Record<string, string> = {
					YYYY: 'YYYY', MM: 'MM', DD: 'DD', hh: 'HH', mm: 'mm', ss: 'ss',
				};
				let result = '';
				let i = 0;
				let litBuf = '';
				while (i < fmt.length) {
					if (fmt[i] === '{') {
						const end = fmt.indexOf('}', i);
						if (end !== -1) {
							if (litBuf) { result += `[${litBuf}]`; litBuf = ''; }
							const tok = fmt.slice(i + 1, end);
							result += tokenMap[tok] ?? `[{${tok}}]`;
							i = end + 1;
							continue;
						}
					}
					litBuf += fmt[i++];
				}
				if (litBuf) result += `[${litBuf}]`;
				return result;
			};

			// For label formats: wrap literal segments in [...] so Moment.js
			// treats them as plain text, not format tokens.
			const migrateLabelFormat = (fmt: string): string => {
				if (!fmt.includes('{')) {
					// No old tokens — wrap the whole thing as a literal,
					// unless it already looks like a Moment.js format string.
					if (!fmt.includes('[')) return `[${fmt}]`;
					return fmt;
				}
				// Has {TOKEN} style — parse, wrap literals in [...], convert tokens.
				const tokenMap: Record<string, string> = {
					YYYY: 'YYYY', MM: 'MM', DD: 'DD', hh: 'HH', mm: 'mm', ss: 'ss',
				};
				let result = '';
				let i = 0;
				let litBuf = '';
				while (i < fmt.length) {
					if (fmt[i] === '{') {
						const end = fmt.indexOf('}', i);
						if (end !== -1) {
							if (litBuf) { result += `[${litBuf}]`; litBuf = ''; }
							const tok = fmt.slice(i + 1, end);
							result += tokenMap[tok] ?? `[{${tok}}]`;
							i = end + 1;
							continue;
						}
					}
					litBuf += fmt[i++];
				}
				if (litBuf) result += `[${litBuf}]`;
				return result;
			};

			if (loaded?.dateFormat) {
				this.settings.dateFormat = migratePattern(loaded.dateFormat);
			}
			if (loaded?.ignorePatterns) {
				this.settings.ignorePatterns = loaded.ignorePatterns.map(migratePattern);
			}
			if (loaded?.todayLabelFormat) {
				this.settings.todayLabelFormat = migrateLabelFormat(loaded.todayLabelFormat);
			}
			if (loaded?.todayLabelForIgnoredFormat) {
				this.settings.todayLabelForIgnoredFormat = migrateLabelFormat(loaded.todayLabelForIgnoredFormat);
			}
			this.settings.settingsVersion = 1;
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refresh();
	}

	// ─── Observer lifecycle ───────────────────────────────────────────────────

	startObserver() {
		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		if (leaves.length === 0) return;

		const container = leaves[0].view.containerEl;

		// Process what's already rendered
		if (this.settings.enabled) {
			this.processContainer(container);
		}

		// Watch for DOM changes in the explorer tree
		this.observer = new MutationObserver((mutations) => {
			if (!this.settings.enabled) return;

			const toProcess = new Set<HTMLElement>();

			for (const mutation of mutations) {
				const target = mutation.target as HTMLElement;

				// Skip mutations we caused (our own spans being inserted)
				if (target instanceof HTMLElement &&
					(target.classList.contains('ta-date') || target.classList.contains('ta-rest'))) {
					continue;
				}

				if (mutation.type === 'childList') {
					// Case 1: a nav-file-title-content was updated in-place (Obsidian
					// empties the element and inserts a new text node on rename)
					if (target instanceof HTMLElement &&
						target.classList.contains('nav-file-title-content')) {
						toProcess.add(target);
					}

					mutation.addedNodes.forEach((node) => {
						if (node instanceof HTMLElement) {
							// Case 2: a whole nav-file-title-content element was added
							if (node.classList.contains('nav-file-title-content')) {
								toProcess.add(node);
							} else {
								// Case 3: a parent element was added (folder expand, initial render)
								node.querySelectorAll<HTMLElement>('.nav-file-title-content')
									.forEach((el) => toProcess.add(el));
							}
						} else {
							// Case 4: a bare text node was added — parent may be title element
							const parent = node.parentElement;
							if (parent?.classList.contains('nav-file-title-content')) {
								toProcess.add(parent);
							}
						}
					});
				}

				// Case 5: text content mutated directly
				if (mutation.type === 'characterData') {
					const parent = mutation.target.parentElement;
					if (parent?.classList.contains('nav-file-title-content')) {
						toProcess.add(parent);
					}
				}
			}

			toProcess.forEach((el) => this.processItem(el));
		});

		this.observer.observe(container, { childList: true, subtree: true, characterData: true });

		// Start the parallel observer for tab titles
		this.startTabObserver();
	}

	stopObserver() {
		this.observer?.disconnect();
		this.observer = null;
		this.stopTabObserver();
	}

	// ─── Tab observer lifecycle ───────────────────────────────────────────────

	/**
	 * Observes the workspace container for mutations to tab-title elements,
	 * skipping mutations that we ourselves caused.
	 */
	startTabObserver() {
		const workspaceEl = (this.app.workspace as unknown as { containerEl: HTMLElement }).containerEl;

		this.tabObserver = new MutationObserver((mutations) => {
			if (!this.settings.enabled) return;
			const toProcess = new Set<HTMLElement>();

			const isTabTitle = (el: Element | null): el is HTMLElement =>
				el instanceof HTMLElement &&
				(el.classList.contains('view-header-title') ||
					el.classList.contains('workspace-tab-header-inner-title'));

			const enqueue = (el: HTMLElement) => {
				const entry = this.tabAliasMap.get(el);
				// Skip if this mutation was caused by us (text still matches our alias)
				if (entry && el.textContent === entry.alias) return;
				if (entry) this.tabAliasMap.delete(el); // Obsidian changed it — clear stale entry
				toProcess.add(el);
			};

			for (const m of mutations) {
				if (m.type === 'characterData') {
					const parent = m.target.parentElement;
					if (isTabTitle(parent)) enqueue(parent);
				}

				if (m.type === 'childList') {
					const t = m.target as HTMLElement;
					if (isTabTitle(t)) enqueue(t);

					m.addedNodes.forEach((node) => {
						if (!(node instanceof HTMLElement)) return;
						if (node.classList.contains('view-header-title') ||
							node.classList.contains('workspace-tab-header-inner-title')) {
							toProcess.add(node);
						} else {
							node.querySelectorAll<HTMLElement>(TodayAliasPlugin.TAB_SELECTORS)
								.forEach((el) => toProcess.add(el));
						}
					});
				}
			}

			toProcess.forEach((el) => this.processTab(el));
		});

		this.tabObserver.observe(workspaceEl, { childList: true, subtree: true, characterData: true });

		// Label whatever is already open
		if (this.settings.enabled) this.processAllTabs();
	}

	stopTabObserver() {
		this.tabObserver?.disconnect();
		this.tabObserver = null;
	}

	// ─── DOM processing ───────────────────────────────────────────────────────

	/**
	 * Walk every .nav-file-title-content element inside `container`
	 * and apply (or skip) date-hiding.
	 */
	processContainer(container: HTMLElement) {
		container.querySelectorAll<HTMLElement>('.nav-file-title-content').forEach((el) => {
			this.processItem(el);
		});
	}

	/**
	 * Splits the title element into a hidden date span and a visible rest span,
	 * or replaces a bare today note with the "Today     -DD" label.
	 * No-ops if the element is already processed, the filename has no date prefix,
	 * or the full filename matches one of the configured ignore patterns.
	 */
	processItem(el: HTMLElement) {
		// Already processed — skip
		if (el.querySelector('.ta-date') || el.querySelector('.ta-today')) return;

		const fullTitle = el.textContent ?? '';

		// Today label: check before ignore patterns so bare-date Daily Notes can
		// still be relabelled even though they match the default ignore list.
		if (this.settings.showTodayLabel) {
			const label = this.getTodayLabel(fullTitle);
			if (label !== null) {
				el.dataset.taOriginal = fullTitle;
				el.empty();
				el.createSpan({ cls: 'ta-today', text: label });
				return;
			}
		}

		// Yesterday label: same logic, for the previous calendar day.
		if (this.settings.showYesterdayLabel) {
			const label = this.getYesterdayLabel(fullTitle);
			if (label !== null) {
				el.dataset.taOriginal = fullTitle;
				el.empty();
				el.createSpan({ cls: 'ta-today', text: label });
				return;
			}
		}

		// Check user-defined ignore patterns against the full filename
		if (this.isIgnored(fullTitle)) {
			// Today prefix for ignored files
			if (this.settings.showTodayLabel && this.settings.showTodayLabelForIgnored) {
				const label = this.getTodayLabelForPrefixed(fullTitle);
				if (label !== null) {
					el.dataset.taOriginal = fullTitle;
					el.empty();
					el.createSpan({ cls: 'ta-today', text: label });
					return;
				}
			}
			// Yesterday prefix for ignored files
			if (this.settings.showYesterdayLabel && this.settings.showYesterdayLabelForIgnored) {
				const label = this.getYesterdayLabelForPrefixed(fullTitle);
				if (label !== null) {
					el.dataset.taOriginal = fullTitle;
					el.empty();
					el.createSpan({ cls: 'ta-today', text: label });
					return;
				}
			}
			return;
		}

		const pattern = this.buildPattern();
		const match = pattern.exec(fullTitle);
		if (!match) return;

		const datePart = match[0];          // e.g. "2026-03-02 "
		const restPart = fullTitle.slice(datePart.length);
		el.dataset.taOriginal = fullTitle;
		el.empty();
		el.createSpan({ cls: 'ta-date', text: datePart });
		if (restPart) el.createSpan({ cls: 'ta-rest', text: restPart });
	}

	/**
	 * Converts a Moment.js format string to a regex string.
	 * Handles `[literal]` escape groups, all common Moment.js tokens,
	 * and optionally `*` as a .* wildcard (used for ignore patterns).
	 */
	private momentFmtToRegexStr(format: string, allowWildcard = false): string {
		// Ordered longest-first so greedy matching picks "MM" before "M", etc.
		const tokens: Array<[string, string]> = [
			['YYYY',  '\\d{4}'],
			['YY',    '\\d{2}'],
			['MMMM',  '[A-Za-z]+'],
			['MMM',   '[A-Za-z]{3}'],
			['MM',    '\\d{2}'],
			['M',     '\\d{1,2}'],
			['DDDD',  '\\d{3}'],
			['DDD',   '\\d{1,3}'],
			['Do',    '\\d{1,2}(?:st|nd|rd|th)'],
			['DD',    '\\d{2}'],
			['D',     '\\d{1,2}'],
			['HH',    '\\d{2}'],
			['H',     '\\d{1,2}'],
			['hh',    '\\d{2}'],
			['h',     '\\d{1,2}'],
			['mm',    '\\d{2}'],
			['m',     '\\d{1,2}'],
			['ss',    '\\d{2}'],
			['s',     '\\d{1,2}'],
			['SSS',   '\\d{3}'],
			['SS',    '\\d{2}'],
			['S',     '\\d'],
			['A',     '(?:AM|PM)'],
			['a',     '(?:am|pm)'],
			['ZZ',    '[+-]\\d{4}'],
			['Z',     '(?:[+-]\\d{2}:\\d{2}|Z)'],
			['X',     '\\d+'],
			['x',     '\\d+'],
		];

		let result = '';
		let i = 0;

		while (i < format.length) {
			// [...] literal escape — output as regex-escaped plain text
			if (format[i] === '[') {
				const end = format.indexOf(']', i + 1);
				if (end !== -1) {
					const lit = format.slice(i + 1, end);
					result += lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					i = end + 1;
					continue;
				}
			}

			// * wildcard (ignore patterns only)
			if (allowWildcard && format[i] === '*') {
				result += '.*';
				i++;
				continue;
			}

			// Try each token (longest first)
			let matched = false;
			for (const [token, pattern] of tokens) {
				if (format.startsWith(token, i)) {
					// Single-character letter tokens (M, D, H, h, m, s, S, A, a, X, x)
					// must NOT be followed by another letter — otherwise they are part
					// of a plain word (e.g. 'M' in 'Meetings') and should be literals.
					if (token.length === 1 && /[a-zA-Z]/.test(token)) {
						const nextChar = format[i + 1];
						if (nextChar && /[a-zA-Z]/.test(nextChar)) {
							break; // fall through to literal handling
						}
					}
					result += pattern;
					i += token.length;
					matched = true;
					break;
				}
			}

			if (!matched) {
				// Literal character — regex-escape it
				result += format[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				i++;
			}
		}

		return result;
	}

	/**
	 * Converts a Moment.js format string (with optional * wildcard) into a
	 * full-match regex (^...$) for use in ignore patterns.
	 */
	formatToIgnorePattern(format: string): RegExp {
		return new RegExp(`^${this.momentFmtToRegexStr(format, true)}$`);
	}

	/**
	 * Returns true if the full filename matches any of the configured ignore patterns.
	 */
	isIgnored(fullTitle: string): boolean {
		for (const raw of this.settings.ignorePatterns) {
			const trimmed = raw.trim();
			if (!trimmed) continue;
			try {
				if (this.formatToIgnorePattern(trimmed).test(fullTitle)) return true;
			} catch {
				// skip silently
			}
		}
		return false;
	}

	// ─── Tab DOM processing ───────────────────────────────────────────────────

	/**
	 * Applies the same alias / date-strip logic to a tab-title element.
	 * Skips the element if it was already processed (tabAliasMap has an entry).
	 */
	processTab(el: HTMLElement) {
		if (this.tabAliasMap.has(el)) return; // already handled

		const fullTitle = el.textContent ?? '';
		if (!fullTitle.trim()) return;

		let alias: string | null = null;

		if (this.settings.showTodayLabel) {
			alias = this.getTodayLabel(fullTitle);
		}
		if (!alias && this.settings.showYesterdayLabel) {
			alias = this.getYesterdayLabel(fullTitle);
		}
		if (!alias && this.isIgnored(fullTitle)) {
			if (this.settings.showTodayLabel && this.settings.showTodayLabelForIgnored) {
				alias = this.getTodayLabelForPrefixed(fullTitle);
			}
			if (!alias && this.settings.showYesterdayLabel && this.settings.showYesterdayLabelForIgnored) {
				alias = this.getYesterdayLabelForPrefixed(fullTitle);
			}
			// Ignored with no today/yesterday alias → leave untouched
			if (!alias) return;
		}
		if (!alias) {
			// Strip the date prefix and show only the rest of the title.
			const match = this.buildPattern().exec(fullTitle);
			if (!match) return;
			const rest = fullTitle.slice(match[0].length);
			if (!rest) return; // bare date with no today/yesterday alias → leave as-is
			alias = rest;
		}

		if (alias === fullTitle) return; // unchanged — nothing to do

		this.tabAliasMap.set(el, { original: fullTitle, alias });
		el.textContent = alias;
	}

	/**
	 * Restores a single tab-title element to its original plain-text.
	 */
	restoreTab(el: HTMLElement) {
		const entry = this.tabAliasMap.get(el);
		if (!entry) return;
		el.textContent = entry.original;
		this.tabAliasMap.delete(el);
	}

	restoreAllTabs() {
		document.querySelectorAll<HTMLElement>(TodayAliasPlugin.TAB_SELECTORS)
			.forEach((el) => this.restoreTab(el));
	}

	processAllTabs() {
		document.querySelectorAll<HTMLElement>(TodayAliasPlugin.TAB_SELECTORS)
			.forEach((el) => this.processTab(el));
	}

	/** Restore all tab titles then re-apply aliases. Used after settings change or day rollover. */
	refreshTabs() {
		this.restoreAllTabs();
		if (this.settings.enabled) this.processAllTabs();
	}

	/**
	 * Restore an element to its original plain-text form.
	 */
	restoreItem(el: HTMLElement) {
		if (!el.querySelector('.ta-date') && !el.querySelector('.ta-today')) return;

		const original = el.dataset.taOriginal ?? '';
		el.empty();
		delete el.dataset.taOriginal;
		if (original) el.textContent = original;
	}

	restoreAllItems() {
		document
			.querySelectorAll<HTMLElement>('.nav-file-title-content')
			.forEach((el) => this.restoreItem(el));
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────

	/**
	 * Returns today's date formatted according to the configured dateFormat
	 * using Moment.js, e.g. "2026-03-04" for the default "YYYY-MM-DD".
	 */
	getTodayDateStr(): string {
		return moment().format(this.settings.dateFormat);
	}

	/**
	 * Returns yesterday's date formatted according to the configured dateFormat.
	 */
	getYesterdayDateStr(): string {
		return moment().subtract(1, 'day').format(this.settings.dateFormat);
	}

	/**
	 * Formats a Moment.js format string with today's date.
	 * Literal text in [...] is preserved as-is.
	 */
	formatTodayLabel(format: string): string {
		return moment().format(format);
	}

	/**
	 * Formats a Moment.js format string with yesterday's date.
	 */
	formatYesterdayLabel(format: string): string {
		return moment().subtract(1, 'day').format(format);
	}

	/**
	 * If fullTitle is exactly today's date, returns the formatted Today label.
	 * Otherwise returns null.
	 */
	getTodayLabel(fullTitle: string): string | null {
		if (fullTitle.trim() !== this.getTodayDateStr()) return null;
		return this.formatTodayLabel(this.settings.todayLabelFormat);
	}

	/**
	 * If fullTitle is exactly yesterday's date, returns the formatted Yesterday label.
	 * Otherwise returns null.
	 */
	getYesterdayLabel(fullTitle: string): string | null {
		if (fullTitle.trim() !== this.getYesterdayDateStr()) return null;
		return this.formatYesterdayLabel(this.settings.yesterdayLabelFormat);
	}

	/**
	 * If fullTitle starts with today's date and has content after it, returns
	 * the formatted Today label prefix with the rest of the filename appended.
	 * Returns null for bare dates (handled by getTodayLabel).
	 */
	getTodayLabelForPrefixed(fullTitle: string): string | null {
		const todayStr = this.getTodayDateStr();
		const escaped = todayStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const match = new RegExp(`^${escaped}\\s*`).exec(fullTitle);
		if (!match) return null;
		const rest = fullTitle.slice(match[0].length);
		if (rest.trim() === '') return null; // bare date — handled by getTodayLabel
		return this.formatTodayLabel(this.settings.todayLabelForIgnoredFormat) + rest;
	}

	/**
	 * If fullTitle starts with yesterday's date and has content after it, returns
	 * the formatted Yesterday label prefix with the rest of the filename appended.
	 * Returns null for bare dates (handled by getYesterdayLabel).
	 */
	getYesterdayLabelForPrefixed(fullTitle: string): string | null {
		const yesterdayStr = this.getYesterdayDateStr();
		const escaped = yesterdayStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const match = new RegExp(`^${escaped}\\s*`).exec(fullTitle);
		if (!match) return null;
		const rest = fullTitle.slice(match[0].length);
		if (rest.trim() === '') return null; // bare date — handled by getYesterdayLabel
		return this.formatYesterdayLabel(this.settings.yesterdayLabelForIgnoredFormat) + rest;
	}

	/**
	 * Checks whether the calendar day has rolled over since the last check.
	 * If so, updates lastKnownDay and triggers a full refresh so the
	 * "Today" label moves to the new date automatically.
	 *
	 * Called by the window-focus listener, the 60-second interval, and the
	 * midnight timeout — any of which may be the first to notice the rollover.
	 */
	checkDateChange() {
		const today = moment().format('YYYY-MM-DD');
		if (today !== this.lastKnownDay) {
			this.lastKnownDay = today;
			this.refresh();
		}
	}

	/**
	 * Schedules a call to checkDateChange at the next midnight as a precise
	 * in-session trigger (complements the focus listener and interval).
	 */
	scheduleMidnightRefresh() {
		const now = new Date();
		const midnight = new Date(now);
		midnight.setDate(midnight.getDate() + 1);
		midnight.setHours(0, 0, 5, 0); // 5 s past midnight
		const ms = midnight.getTime() - now.getTime();
		const id = window.setTimeout(() => {
			this.checkDateChange();
			this.scheduleMidnightRefresh();
		}, ms);
		this.register(() => window.clearTimeout(id));
	}

	/**
	 * Converts a Moment.js format string to a regex that matches that date prefix.
	 * Wraps in ^(...)\s* so it anchors at the start and swallows trailing spaces.
	 */
	formatToPattern(format: string): RegExp {
		return new RegExp(`^(${this.momentFmtToRegexStr(format, false)})\\s*`);
	}

	buildPattern(): RegExp {
		try {
			return this.formatToPattern(this.settings.dateFormat);
		} catch {
			return this.formatToPattern(DEFAULT_SETTINGS.dateFormat);
		}
	}

	/**
	 * Called after settings change: restore everything, then re-apply if enabled.
	 */
	refresh() {
		this.restoreAllItems();
		this.restoreAllTabs();
		if (this.settings.enabled) {
			document
				.querySelectorAll<HTMLElement>('.nav-file-title-content')
				.forEach((el) => this.processItem(el));
			this.processAllTabs();
		}
	}
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class TodayAliasSettingTab extends PluginSettingTab {
	plugin: TodayAliasPlugin;

	constructor(app: App, plugin: TodayAliasPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Helper: create a live-preview line for a Moment.js format string
		const makePreview = (fmt: string): string => {
			try {
				return 'Preview: ' + moment().format(fmt || DEFAULT_SETTINGS.dateFormat);
			} catch {
				return 'Preview: (invalid format)';
			}
		};

		// ── Enable ────────────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName('Enable')
			.setDesc('Toggle date-prefix hiding in the file explorer.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enabled)
					.onChange(async (value) => {
						this.plugin.settings.enabled = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Date format ───────────────────────────────────────────────────────

		let dateFormatPreviewEl: HTMLElement;

		new Setting(containerEl)
			.setName('Date format')
			.setDesc(createFragment((frag) => {
				frag.appendText('Moment.js format string for the date prefix to hide. See ');
				frag.createEl('a', {
					text: 'Format reference',
					href: 'https://momentjs.com/docs/#/displaying/format/',
					attr: { target: '_blank' },
				});
				frag.appendText('. Default: YYYY-MM-DD.');
				frag.createEl('br');
				dateFormatPreviewEl = frag.createEl('span', { cls: 'ta-preview' });
				dateFormatPreviewEl.textContent = makePreview(this.plugin.settings.dateFormat);
			}))
			.addText((text) => {
				text
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (value) => {
						const fmt = value.trim() || DEFAULT_SETTINGS.dateFormat;
						this.plugin.settings.dateFormat = fmt;
						dateFormatPreviewEl.textContent = makePreview(fmt);
						await this.plugin.saveSettings();
					});
			});

		// ── Today / Yesterday labels ─────────────────────────────────────────
		//
		// Each row has 4 inline controls:
		//   [toggle: show bare-note label]  [text: bare-note format]
		//   [toggle: show prefix for pattern matches]  [text: prefix format]
		//
		// Inputs are disabled when their governing toggle is off.

		// ── Today ──────────────────────────────────────────────────────────────
		let todayLabelInp: TextComponent;
		let todayPrefixInp: TextComponent;
		let todayPreviewEl: HTMLElement;

		const refreshTodayPreview = () => {
			const bare = this.plugin.settings.showTodayLabel
				? moment().format(this.plugin.settings.todayLabelFormat)
				: '(off)';
			const prefix = this.plugin.settings.showTodayLabelForIgnored
				? moment().format(this.plugin.settings.todayLabelForIgnoredFormat) + '…'
				: '(off)';
			todayPreviewEl.empty();
			todayPreviewEl.appendText(`Date only: ${bare}`);
			todayPreviewEl.createEl('br');
			todayPreviewEl.appendText(`Prefix: ${prefix}`);
		};

		const todaySetting = new Setting(containerEl)
			.setName('Today')
			.setClass('ta-day-setting')
			.setDesc(createFragment((frag) => {
				frag.appendText('Labels for today\'s date. Use ');
				frag.createEl('code', { text: '[literal]' });
				frag.appendText(' to escape non-token characters. Bare-note toggle+format ┆ Pattern-prefix toggle+format.');
				frag.createEl('br');
				todayPreviewEl = frag.createEl('span', { cls: 'ta-preview' });
			}))
			.addToggle((t) =>
				t.setTooltip('Show label for bare today note')
					.setValue(this.plugin.settings.showTodayLabel)
					.onChange(async (v) => {
						this.plugin.settings.showTodayLabel = v;
						todayLabelInp.setDisabled(!v);
						refreshTodayPreview();
						await this.plugin.saveSettings();
					})
			)
			.addText((text) => {
				todayLabelInp = text;
				text.setPlaceholder(DEFAULT_SETTINGS.todayLabelFormat)
					.setValue(this.plugin.settings.todayLabelFormat)
					.onChange(async (value) => {
						const fmt = value || DEFAULT_SETTINGS.todayLabelFormat;
						this.plugin.settings.todayLabelFormat = fmt;
						refreshTodayPreview();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass('ta-label-input');
				text.setDisabled(!this.plugin.settings.showTodayLabel);
			})
			.addToggle((t) =>
				t.setTooltip('Show prefix label for pattern-matched notes')
					.setValue(this.plugin.settings.showTodayLabelForIgnored)
					.onChange(async (v) => {
						this.plugin.settings.showTodayLabelForIgnored = v;
						todayPrefixInp.setDisabled(!v);
						refreshTodayPreview();
						await this.plugin.saveSettings();
					})
			)
			.addText((text) => {
				todayPrefixInp = text;
				text.setPlaceholder(DEFAULT_SETTINGS.todayLabelForIgnoredFormat)
					.setValue(this.plugin.settings.todayLabelForIgnoredFormat)
					.onChange(async (value) => {
						const fmt = value || DEFAULT_SETTINGS.todayLabelForIgnoredFormat;
						this.plugin.settings.todayLabelForIgnoredFormat = fmt;
						refreshTodayPreview();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass('ta-prefix-input');
				text.setDisabled(!this.plugin.settings.showTodayLabelForIgnored);
			});
		refreshTodayPreview();
		// Wrap the 4 control children into two toggle+input pairs
		{
			const ctrl = todaySetting.settingEl.querySelector<HTMLElement>('.setting-item-control');
			if (ctrl) {
				const ch = Array.from(ctrl.children);
				const g1 = ctrl.createDiv({ cls: 'ta-ctrl-group' });
				const g2 = ctrl.createDiv({ cls: 'ta-ctrl-group' });
				g1.append(ch[0], ch[1]);
				g2.append(ch[2], ch[3]);
			}
		}

		// ── Yesterday
		let yesterdayLabelInp: TextComponent;
		let yesterdayPrefixInp: TextComponent;
		let yesterdayPreviewEl: HTMLElement;

		const refreshYesterdayPreview = () => {
			const bare = this.plugin.settings.showYesterdayLabel
				? moment().subtract(1, 'day').format(this.plugin.settings.yesterdayLabelFormat)
				: '(off)';
			const prefix = this.plugin.settings.showYesterdayLabelForIgnored
				? moment().subtract(1, 'day').format(this.plugin.settings.yesterdayLabelForIgnoredFormat) + '…'
				: '(off)';
			yesterdayPreviewEl.empty();
			yesterdayPreviewEl.appendText(`Date only: ${bare}`);
			yesterdayPreviewEl.createEl('br');
			yesterdayPreviewEl.appendText(`Prefix: ${prefix}`);
		};

		const yesterdaySetting = new Setting(containerEl)
			.setName('Yesterday')
			.setClass('ta-day-setting')
			.setDesc(createFragment((frag) => {
				frag.appendText('Labels for yesterday\'s date. Use ');
				frag.createEl('code', { text: '[literal]' });
				frag.appendText(' to escape non-token characters. Bare-note toggle+format ┆ Pattern-prefix toggle+format.');
				frag.createEl('br');
				yesterdayPreviewEl = frag.createEl('span', { cls: 'ta-preview' });
			}))
			.addToggle((t) =>
				t.setTooltip('Show label for bare yesterday note')
					.setValue(this.plugin.settings.showYesterdayLabel)
					.onChange(async (v) => {
						this.plugin.settings.showYesterdayLabel = v;
						yesterdayLabelInp.setDisabled(!v);
						refreshYesterdayPreview();
						await this.plugin.saveSettings();
					})
			)
			.addText((text) => {
				yesterdayLabelInp = text;
				text.setPlaceholder(DEFAULT_SETTINGS.yesterdayLabelFormat)
					.setValue(this.plugin.settings.yesterdayLabelFormat)
					.onChange(async (value) => {
						const fmt = value || DEFAULT_SETTINGS.yesterdayLabelFormat;
						this.plugin.settings.yesterdayLabelFormat = fmt;
						refreshYesterdayPreview();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass('ta-label-input');
				text.setDisabled(!this.plugin.settings.showYesterdayLabel);
			})
			.addToggle((t) =>
				t.setTooltip('Show prefix label for pattern-matched notes')
					.setValue(this.plugin.settings.showYesterdayLabelForIgnored)
					.onChange(async (v) => {
						this.plugin.settings.showYesterdayLabelForIgnored = v;
						yesterdayPrefixInp.setDisabled(!v);
						refreshYesterdayPreview();
						await this.plugin.saveSettings();
					})
			)
			.addText((text) => {
				yesterdayPrefixInp = text;
				text.setPlaceholder(DEFAULT_SETTINGS.yesterdayLabelForIgnoredFormat)
					.setValue(this.plugin.settings.yesterdayLabelForIgnoredFormat)
					.onChange(async (value) => {
						const fmt = value || DEFAULT_SETTINGS.yesterdayLabelForIgnoredFormat;
						this.plugin.settings.yesterdayLabelForIgnoredFormat = fmt;
						refreshYesterdayPreview();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass('ta-prefix-input');
				text.setDisabled(!this.plugin.settings.showYesterdayLabelForIgnored);
			});
		refreshYesterdayPreview();
		// Wrap the 4 control children into two toggle+input pairs
		{
			const ctrl = yesterdaySetting.settingEl.querySelector<HTMLElement>('.setting-item-control');
			if (ctrl) {
				const ch = Array.from(ctrl.children);
				const g1 = ctrl.createDiv({ cls: 'ta-ctrl-group' });
				const g2 = ctrl.createDiv({ cls: 'ta-ctrl-group' });
				g1.append(ch[0], ch[1]);
				g2.append(ch[2], ch[3]);
			}
		}

		// ── Other pattern matching ────────────────────────────────────────────

		// Helper: format all non-empty ignore patterns with today's date and
		// display them as a comma-separated preview (same style as other fields).
		const makeIgnorePreview = (patterns: string[]): string => {
			const nonEmpty = patterns.map((p) => p.trim()).filter((p) => p.length > 0);
			if (nonEmpty.length === 0) return '';
			return nonEmpty
				.map((pat) => {
					try { return moment().format(pat); } catch { return '(invalid)'; }
				})
				.join('  ·  ');
		};

		let ignorePreviewEl: HTMLElement;

		const ignoreSetting = new Setting(containerEl)
			.setName('Other pattern matching (one per line)')
			.setDesc(createFragment((frag) => {
				frag.appendText('Files whose full name matches any pattern are left untouched. Uses ');
				frag.createEl('a', {
					text: 'Moment.js format tokens',
					href: 'https://momentjs.com/docs/#/displaying/format/',
					attr: { target: '_blank' },
				});
				frag.appendText(' (e.g. YYYY, MM, DD); use ');
				frag.createEl('code', { text: '*' });
				frag.appendText(' as a wildcard and ');
				frag.createEl('code', { text: '[...]' });
				frag.appendText(' to escape literal words (without brackets, stray letters like M are parsed as tokens).');
				frag.createEl('br');
				frag.appendText('Example: ');
				frag.createEl('code', { text: 'YYYY-MM-DD [M!]*' });
				frag.appendText(' matches any file starting with a date followed by " M!".');
				frag.createEl('br');
				ignorePreviewEl = frag.createEl('span', { cls: 'ta-preview' });
				ignorePreviewEl.textContent = makeIgnorePreview(this.plugin.settings.ignorePatterns);
			}))
			.addTextArea((area) => {
				area
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings.ignorePatterns.join('\n'))
					.onChange(async (value) => {
						const patterns = value
							.split('\n')
							.map((l) => l.trim())
							.filter((l) => l.length > 0);
						this.plugin.settings.ignorePatterns = patterns;
						ignorePreviewEl.textContent = makeIgnorePreview(patterns);
						await this.plugin.saveSettings();
					});
				area.inputEl.addClass('ta-ignore-textarea');
				area.inputEl.rows = 3;
			});
		// Move the textarea below the description instead of beside it
		ignoreSetting.settingEl.addClass('ta-ignore-setting');
	}
}
