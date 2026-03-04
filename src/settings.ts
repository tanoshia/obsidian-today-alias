export interface HideDatePrefixSettings {
	/** Whether the plugin is active. */
	enabled: boolean;
	/**
	 * Moment.js format string matching the date prefix in filenames.
	 * See https://momentjs.com/docs/#/displaying/format/
	 * Default: "YYYY-MM-DD".
	 */
	dateFormat: string;
	/**
	 * List of Moment.js format strings (one per line) matched against the FULL filename.
	 * Supports all Moment.js tokens plus * as a wildcard.
	 * If any pattern matches, the file is left untouched (date not hidden).
	 */
	ignorePatterns: string[];
	/**
	 * When true, a Daily Note whose filename is exactly today's date is shown
	 * using todayLabelFormat instead of the raw date.
	 */
	showTodayLabel: boolean;
	/**
	 * Moment.js format string for the Today label on bare daily notes.
	 * Use [...] to wrap literal text (e.g. "[Today     -]DD").
	 */
	todayLabelFormat: string;
	/**
	 * When true, files that match an ignore pattern but start with today's date
	 * also get the Today label (using todayLabelForIgnoredFormat).
	 */
	showTodayLabelForIgnored: boolean;
	/**
	 * Moment.js format string for the Today label prefix on ignored-pattern matches.
	 * Use [...] to wrap literal text. The rest of the filename is appended after.
	 */
	todayLabelForIgnoredFormat: string;
	/**
	 * Internal version — used to migrate settings from older formats.
	 * Undefined means pre-1.4.0 ({TOKEN} style). 1 = Moment.js style.
	 */
	settingsVersion?: number;
}

export const DEFAULT_SETTINGS: HideDatePrefixSettings = {
	enabled: true,
	dateFormat: 'YYYY-MM-DD',
	ignorePatterns: [
		'YYYY-MM-DD',
		'YYYY-MM-DD [Meetings]',
	],
	showTodayLabel: true,
	todayLabelFormat: '[✘ Today, ]MMM Do',
	showTodayLabelForIgnored: true,
	todayLabelForIgnoredFormat: "[✘ Today's ]",
	settingsVersion: 1,
};
