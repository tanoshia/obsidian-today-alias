export interface HideDatePrefixSettings {
	/** Whether the plugin is active. */
	enabled: boolean;
	/**
	 * A regex string (anchored at start) that captures the date portion to hide.
	 * Default matches `YYYY-MM-DD` optionally followed by one or more spaces.
	 */
	datePattern: string;
}

export const DEFAULT_SETTINGS: HideDatePrefixSettings = {
	enabled: true,
	datePattern: '^(\\d{4}-\\d{2}-\\d{2})\\s*',
};
