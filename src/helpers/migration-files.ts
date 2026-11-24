/** Windows rejects `:` in filenames, so timestamps in filenames use `-`. */
export function fileTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, '-');
}

export function migrationFilename(iso: string): string {
	return `migration-${fileTimestamp(iso)}.json`;
}

export function dryRunFilename(iso: string): string {
	return `dry-run-${fileTimestamp(iso)}.json`;
}

const FILE_TIMESTAMP =
	/(\d{4}-\d{2}-\d{2}T\d{2})[:-](\d{2})[:-](\d{2})[.-](\d{3})Z/;

/**
 * Read the time from a filename written with either {@link fileTimestamp} or
 * a raw ISO timestamp (files saved before Windows-safe names).
 */
export function parseFileTimestamp(filename: string): Date | undefined {
	const match = FILE_TIMESTAMP.exec(filename);
	if (!match) return undefined;
	const [, dateHour, minutes, seconds, millis] = match;
	const date = new Date(`${dateHour}:${minutes}:${seconds}.${millis}Z`);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Newest first; files without a readable timestamp go last. */
export function sortNewestFirst(filenames: string[]): string[] {
	const time = (filename: string) =>
		parseFileTimestamp(filename)?.getTime() ?? Number.NEGATIVE_INFINITY;
	return [...filenames].sort(
		(a, b) => time(b) - time(a) || (a < b ? 1 : a > b ? -1 : 0),
	);
}
