import { App, Plugin, PluginSettingTab, Setting, moment } from 'obsidian';
import { HideDatePrefixSettings, DEFAULT_SETTINGS } from './settings';

export default class HideDatePrefixPlugin extends Plugin {
	settings: HideDatePrefixSettings;
	private observer: MutationObserver | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new HideDatePrefixSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.startObserver();
		});

		// Refresh at midnight so the "Today" label moves to the new day automatically
		this.scheduleMidnightRefresh();

		// Re-process after any vault rename so the explorer always reflects the
		// latest filename immediately, regardless of how Obsidian updates the DOM.
		this.registerEvent(this.app.vault.on('rename', () => {
			if (!this.settings.enabled) return;
			setTimeout(() => {
				document
					.querySelectorAll<HTMLElement>('.nav-file-title-content')
					.forEach((el) => this.processItem(el));
			}, 50);
		}));
	}

	onunload() {
		this.stopObserver();
		this.restoreAllItems();
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

		const container = (leaves[0].view as any).containerEl as HTMLElement;

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
					(target.classList.contains('hdp-date') || target.classList.contains('hdp-rest'))) {
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
	}

	stopObserver() {
		this.observer?.disconnect();
		this.observer = null;
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
		if (el.querySelector('.hdp-date') || el.querySelector('.hdp-today')) return;

		const fullTitle = el.textContent ?? '';

		// Today label: check before ignore patterns so bare-date Daily Notes can
		// still be relabelled even though they match the default ignore list.
		if (this.settings.showTodayLabel) {
			const label = this.getTodayLabel(fullTitle);
			if (label !== null) {
				el.dataset.hdpOriginal = fullTitle;
				el.empty();
				el.createSpan({ cls: 'hdp-today', text: label });
				return;
			}
		}

		// Check user-defined ignore patterns against the full filename
		if (this.isIgnored(fullTitle)) {
			// Even for ignored files, show the "Today" label if the option is on
			// and the filename starts with today's date.
			if (this.settings.showTodayLabel && this.settings.showTodayLabelForIgnored) {
				const label = this.getTodayLabelForPrefixed(fullTitle);
				if (label !== null) {
					el.dataset.hdpOriginal = fullTitle;
					el.empty();
					el.createSpan({ cls: 'hdp-today', text: label });
				}
			}
			return;
		}

		const pattern = this.buildPattern();
		const match = pattern.exec(fullTitle);
		if (!match) return;

		const datePart = match[0];          // e.g. "2026-03-02 "
		const restPart = fullTitle.slice(datePart.length);
		el.dataset.hdpOriginal = fullTitle;
		el.empty();
		el.createSpan({ cls: 'hdp-date', text: datePart });
		if (restPart) el.createSpan({ cls: 'hdp-rest', text: restPart });
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

	/**
	 * Restore an element to its original plain-text form.
	 */
	restoreItem(el: HTMLElement) {
		if (!el.querySelector('.hdp-date') && !el.querySelector('.hdp-today')) return;

		const original = el.dataset.hdpOriginal ?? '';
		el.empty();
		delete el.dataset.hdpOriginal;
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
	 * Formats a Moment.js format string with today's date.
	 * Literal text in [...] is preserved as-is.
	 */
	formatTodayLabel(format: string): string {
		return moment().format(format);
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
	 * Schedules a refresh at the next midnight so the "Today" label
	 * automatically moves to the new date without restarting Obsidian.
	 */
	scheduleMidnightRefresh() {
		const now = new Date();
		const midnight = new Date(now);
		midnight.setDate(midnight.getDate() + 1);
		midnight.setHours(0, 0, 5, 0); // 5 s past midnight
		const ms = midnight.getTime() - now.getTime();
		const id = window.setTimeout(() => {
			this.refresh();
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
		if (this.settings.enabled) {
			document
				.querySelectorAll<HTMLElement>('.nav-file-title-content')
				.forEach((el) => this.processItem(el));
		}
	}
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class HideDatePrefixSettingTab extends PluginSettingTab {
	plugin: HideDatePrefixPlugin;

	constructor(app: App, plugin: HideDatePrefixPlugin) {
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
					text: 'format reference',
					href: 'https://momentjs.com/docs/#/displaying/format/',
					attr: { target: '_blank' },
				});
				frag.appendText('. Default: YYYY-MM-DD.');
				frag.createEl('br');
				dateFormatPreviewEl = frag.createEl('span', { cls: 'hdp-preview' });
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

		// ── Ignore patterns ───────────────────────────────────────────────────
		const ignoreSetting = new Setting(containerEl)
			.setName('Patterns to ignore (one per line)')
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
			}))
			.addTextArea((area) => {
				area
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings.ignorePatterns.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns = value
							.split('\n')
							.map((l) => l.trim())
							.filter((l) => l.length > 0);
						await this.plugin.saveSettings();
					});
				area.inputEl.style.width = '100%';
				area.inputEl.rows = 3;
			});
		// Move the textarea below the description instead of beside it
		ignoreSetting.settingEl.style.flexWrap = 'wrap';
		const ignoreControlEl = ignoreSetting.settingEl.querySelector('.setting-item-control') as HTMLElement | null;
		if (ignoreControlEl) {
			ignoreControlEl.style.flexBasis = '100%';
			ignoreControlEl.style.maxWidth = '100%';
			ignoreControlEl.style.marginTop = '6px';
		}

		// ── Today label for bare daily notes ──────────────────────────────────
		let todayFormatSetting: Setting;

		new Setting(containerEl)
			.setName('Show "Today" label for daily note')
			.setDesc(createFragment((frag) => {
				frag.appendText('Replaces a bare today filename with a custom label. Updates at midnight.');
				frag.createEl('br');
				frag.appendText(`Example: "${moment().format(this.plugin.settings.dateFormat)}" → "` +
					`${moment().format(this.plugin.settings.todayLabelFormat)}".`);
			}))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showTodayLabel)
					.onChange(async (value) => {
						this.plugin.settings.showTodayLabel = value;
						todayFormatSetting.settingEl.style.display = value ? '' : 'none';
						await this.plugin.saveSettings();
					})
			);

		let todayPreviewEl: HTMLElement;
		todayFormatSetting = new Setting(containerEl)
			.setName('Label format')
			.setDesc(createFragment((frag) => {
				frag.appendText('Moment.js format. Use ');
				frag.createEl('code', { text: '[literal text]' });
				frag.appendText(' to prevent letters being treated as tokens. Default: ');
				frag.createEl('code', { text: DEFAULT_SETTINGS.todayLabelFormat });
				frag.appendText('.');
				frag.createEl('br');
				todayPreviewEl = frag.createEl('span', { cls: 'hdp-preview' });
				todayPreviewEl.textContent = makePreview(this.plugin.settings.todayLabelFormat);
			}))
			.setClass('hdp-sub-setting')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.todayLabelFormat)
					.setValue(this.plugin.settings.todayLabelFormat)
					.onChange(async (value) => {
						const fmt = value || DEFAULT_SETTINGS.todayLabelFormat;
						this.plugin.settings.todayLabelFormat = fmt;
						todayPreviewEl.textContent = makePreview(fmt);
						await this.plugin.saveSettings();
					})
			);
		todayFormatSetting.settingEl.style.display = this.plugin.settings.showTodayLabel ? '' : 'none';

		// ── Today label for ignore-pattern matches ────────────────────────────
		let todayIgnoredFormatSetting: Setting;

		new Setting(containerEl)
			.setName('Show "Today" label for pattern-ignored files')
			.setDesc(createFragment((frag) => {
				frag.appendText('Also applies a Today prefix to ignored-pattern files starting with today\'s date.');
				frag.createEl('br');
				frag.appendText(`Example: "${moment().format(this.plugin.settings.dateFormat)} Meetings" → "` +
					`${moment().format(this.plugin.settings.todayLabelForIgnoredFormat)}Meetings".`);
			}))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showTodayLabelForIgnored)
					.onChange(async (value) => {
						this.plugin.settings.showTodayLabelForIgnored = value;
						todayIgnoredFormatSetting.settingEl.style.display = value ? '' : 'none';
						await this.plugin.saveSettings();
					})
			);

		let todayIgnoredPreviewEl: HTMLElement;
		todayIgnoredFormatSetting = new Setting(containerEl)
			.setName('Label format (prefix)')
			.setDesc(createFragment((frag) => {
				frag.appendText('Moment.js format prepended to the filename remainder. Use ');
				frag.createEl('code', { text: '[literal text]' });
				frag.appendText(' for non-token text. Default: ');
				frag.createEl('code', { text: DEFAULT_SETTINGS.todayLabelForIgnoredFormat });
				frag.appendText('.');
				frag.createEl('br');
				todayIgnoredPreviewEl = frag.createEl('span', { cls: 'hdp-preview' });
				todayIgnoredPreviewEl.textContent = makePreview(this.plugin.settings.todayLabelForIgnoredFormat);
			}))
			.setClass('hdp-sub-setting')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.todayLabelForIgnoredFormat)
					.setValue(this.plugin.settings.todayLabelForIgnoredFormat)
					.onChange(async (value) => {
						const fmt = value || DEFAULT_SETTINGS.todayLabelForIgnoredFormat;
						this.plugin.settings.todayLabelForIgnoredFormat = fmt;
						todayIgnoredPreviewEl.textContent = makePreview(fmt);
						await this.plugin.saveSettings();
					})
			);
		todayIgnoredFormatSetting.settingEl.style.display =
			this.plugin.settings.showTodayLabelForIgnored ? '' : 'none';
	}
}
