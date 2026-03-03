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
	 * Splits the title element into a hidden date span and a visible rest span.
	 * No-ops if the element is already processed, the filename has no date prefix,
	 * or the full filename matches one of the configured ignore patterns.
	 */
	processItem(el: HTMLElement) {
		// Already processed — skip
		if (el.querySelector('.hdp-date')) return;

		const fullTitle = el.textContent ?? '';

		// Check user-defined ignore patterns against the full filename
		if (this.isIgnored(fullTitle)) return;

		const pattern = this.buildPattern();
		const match = pattern.exec(fullTitle);
		if (!match) return;

		const datePart = match[0];          // e.g. "2026-03-02 "
		const restPart = fullTitle.slice(datePart.length);
		// Safety net: skip if nothing remains after the date
		if (restPart.trim() === '') return;
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
		if (!el.querySelector('.hdp-date')) return;

		const full = el.textContent ?? '';
		el.empty();
		el.textContent = full;
	}

	restoreAllItems() {
		document
			.querySelectorAll<HTMLElement>('.nav-file-title-content')
			.forEach((el) => this.restoreItem(el));
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────

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

		new Setting(containerEl)
			.setName('Date pattern (regex)')
			.setDesc(
				'Regular expression matched against the start of each filename. ' +
				'Default: ^(\\d{4}-\\d{2}-\\d{2})\\s* — matches YYYY-MM-DD optionally followed by spaces. ' +
				'Change this if your date format differs (e.g. ^(\\d{8})\\s* for 20260302).'
			)
			.addText((text) =>
				text
					.setPlaceholder('^(\\d{4}-\\d{2}-\\d{2})\\s*')
					.setValue(this.plugin.settings.datePattern)
					.onChange(async (value) => {
						this.plugin.settings.datePattern = value.trim() || DEFAULT_SETTINGS.datePattern;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Ignore patterns (one regex per line)')
			.setDesc(
				'If the FULL filename matches any of these patterns, the date is not hidden. ' +
				'One regex per line. ' +
				'Default: ^\\d{4}-\\d{2}-\\d{2}$ — leaves bare Daily Notes (e.g. "2026-02-03") untouched. ' +
				'Example to also ignore "2026-02-03 Meetings": add ^\\d{4}-\\d{2}-\\d{2}\\s+Meetings?$'
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
			});
	}
}
