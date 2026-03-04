export interface HideDatePrefixSettings {
	/** Whether the plugin is active. */
	enabled: boolean;
	/**
	 * A regex string (anchored at start) that captures the date portion to hide.
	 * Default matches `YYYY-MM-DD` optionally followed by one or more spaces.
	 */
	datePattern: string;
	/**
	 * List of regex strings (one per line in UI) matched against the FULL filename.
	 * If any pattern matches, the file is left untouched (date not hidden).
	 * Default: bare date-only filenames, e.g. Daily Notes like "2026-02-03".
	 */
	ignorePatterns: string[];
	/**
	 * When true, a Daily Note whose filename is exactly today's date is shown
	 * as "Today     -DD" instead of the raw date.
	 */
	showTodayLabel: boolean;
	/**
	 * When true, files that match an ignore pattern but whose filename starts
	 * with today's date will also have the date replaced with "Today".
	 * e.g. "2026-03-03 Meetings" → "Today Meetings".
	 */
	showTodayLabelForIgnored: boolean;
}

export const DEFAULT_SETTINGS: HideDatePrefixSettings = {
	enabled: true,
	datePattern: '^(\\d{4}-\\d{2}-\\d{2})\\s*',
	ignorePatterns: [
		'^\\d{4}-\\d{2}-\\d{2}$',
		'^\\d{4}-\\d{2}-\\d{2}\\s+Meetings?$',
	],
	showTodayLabel: true,
	showTodayLabelForIgnored: true,
};
