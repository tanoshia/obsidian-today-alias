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

		// Watch for new items being added to the explorer tree
		this.observer = new MutationObserver((mutations) => {
			if (!this.settings.enabled) return;
			for (const mutation of mutations) {
				mutation.addedNodes.forEach((node) => {
					if (node instanceof HTMLElement) {
						this.processContainer(node);
					}
				});
			}
		});

		this.observer.observe(container, { childList: true, subtree: true });
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
	 * No-ops if the element is already processed or the filename has no date prefix.
	 */
	processItem(el: HTMLElement) {
		// Already processed — skip
		if (el.querySelector('.hdp-date')) return;

		const fullTitle = el.textContent ?? '';
		const pattern = this.buildPattern();
		const match = pattern.exec(fullTitle);
		if (!match) return;

		const datePart = match[0];          // e.g. "2026-03-02 "
		const restPart = fullTitle.slice(datePart.length);

		el.empty();
		el.createSpan({ cls: 'hdp-date', text: datePart });
		el.createSpan({ cls: 'hdp-rest', text: restPart });
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
	}
}
