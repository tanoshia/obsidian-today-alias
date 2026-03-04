import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
		// Safety net: skip if nothing remains after the date
		if (restPart.trim() === '') return;
		el.dataset.hdpOriginal = fullTitle;
		el.empty();
		el.createSpan({ cls: 'hdp-date', text: datePart });
		el.createSpan({ cls: 'hdp-rest', text: restPart });
	}

	/**
	 * Returns true if the full filename matches any of the configured ignore patterns.
	 */
	isIgnored(fullTitle: string): boolean {
		for (const raw of this.settings.ignorePatterns) {
			const trimmed = raw.trim();
			if (!trimmed) continue;
			try {
				if (new RegExp(trimmed).test(fullTitle)) return true;
			} catch {
				// invalid regex — skip silently
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
	 * If fullTitle is exactly today's date (YYYY-MM-DD), returns the display
	 * label "Today     -DD". Otherwise returns null.
	 */
	getTodayLabel(fullTitle: string): string | null {
		const now = new Date();
		const yyyy = now.getFullYear();
		const mm = String(now.getMonth() + 1).padStart(2, '0');
		const dd = String(now.getDate()).padStart(2, '0');
		const todayStr = `${yyyy}-${mm}-${dd}`;
		if (fullTitle.trim() !== todayStr) return null;
		return `Today     -${dd}`;
	}

	/**
	 * If fullTitle starts with today's date followed by optional whitespace and
	 * has additional content after the date, returns the title with the date
	 * replaced by "Today". e.g. "2026-03-03 Meetings" → "Today Meetings".
	 * Returns null if the title doesn't start with today's date or has nothing
	 * after the date (bare dates are handled by getTodayLabel instead).
	 */
	getTodayLabelForPrefixed(fullTitle: string): string | null {
		const now = new Date();
		const yyyy = now.getFullYear();
		const mm = String(now.getMonth() + 1).padStart(2, '0');
		const dd = String(now.getDate()).padStart(2, '0');
		const todayStr = `${yyyy}-${mm}-${dd}`;
		const match = new RegExp(`^${todayStr}\\s*`).exec(fullTitle);
		if (!match) return null;
		const rest = fullTitle.slice(match[0].length);
		if (rest.trim() === '') return null; // bare date — handled by getTodayLabel
		return `Today     -${dd} ${rest}`;
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

	buildPattern(): RegExp {
		try {
			return new RegExp(this.settings.datePattern);
		} catch {
			// Fall back to default if user supplied an invalid regex
			return new RegExp(DEFAULT_SETTINGS.datePattern);
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

		let datePatternInputEl: HTMLInputElement | null = null;

		new Setting(containerEl)
			.setName('Date pattern (regex)')
			.setDesc(
				'Regex anchored at the start of each filename that identifies the date prefix to hide. ' +
				'Example: ^(\\d{8})\\s* for filenames like 20260303.'
			)
			.addText((text) => {
				datePatternInputEl = text.inputEl;
				text
					.setPlaceholder('^(\\d{4}-\\d{2}-\\d{2})\\s*')
					.setValue(this.plugin.settings.datePattern)
					.onChange(async (value) => {
						this.plugin.settings.datePattern = value.trim() || DEFAULT_SETTINGS.datePattern;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Ignore patterns (one regex per line)')
			.setDesc(
				'Files whose full name matches any pattern are left untouched (date prefix not hidden). One regex per line. ' +
				'Example: ^\\d{4}-\\d{2}-\\d{2}$ ignores bare daily notes like "2026-02-03".'
			)
			.addTextArea((area) => {
				area
					.setPlaceholder('^\\d{4}-\\d{2}-\\d{2}$')
					.setValue(this.plugin.settings.ignorePatterns.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns = value
							.split('\n')
							.map((l) => l.trim())
							.filter((l) => l.length > 0);
						await this.plugin.saveSettings();
					});
				area.inputEl.style.width = '100%';
				area.inputEl.rows = 5;
				// Match the min-width of the "Date pattern" text input above
				window.requestAnimationFrame(() => {
					if (datePatternInputEl) {
						area.inputEl.style.minWidth = datePatternInputEl.offsetWidth + 'px';
					}
				});
			});

		new Setting(containerEl)
			.setName('Show "Today" label for today\'s daily note')
			.setDesc(
				'Replaces today\'s date with a "Today" label in the file explorer. Updates automatically at midnight. ' +
				'Example: "2026-03-03" → "Today     -03".'
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showTodayLabel)
					.onChange(async (value) => {
						this.plugin.settings.showTodayLabel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Show "Today" label for ignore-pattern matches')
			.setDesc(
				'Also applies the Today label to files that match an ignore pattern but start with today\'s date. ' +
				'Requires: "Show Today label" enabled. Example: "2026-03-03 Meetings" → "Today     -03 Meetings".'
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showTodayLabelForIgnored)
					.onChange(async (value) => {
						this.plugin.settings.showTodayLabelForIgnored = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
