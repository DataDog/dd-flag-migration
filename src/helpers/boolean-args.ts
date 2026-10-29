export class ArgParseError extends Error {}

export function parseBooleanValue(raw: string, flag: string): boolean {
	const value = raw.trim().toLowerCase();
	if (value === 'true' || value === '1' || value === 'yes') return true;
	if (value === 'false' || value === '0' || value === 'no') return false;
	throw new ArgParseError(
		`${flag} expects a boolean (true|false), got: ${raw}`,
	);
}

/** Read an optional boolean value without consuming the following option. */
export function parseBooleanOption(
	argv: string[],
	index: number,
): { value: boolean; nextIndex: number } {
	const arg = argv[index];
	const equals = arg.indexOf('=');
	if (equals !== -1) {
		return {
			value: parseBooleanValue(arg.slice(equals + 1), arg.slice(0, equals)),
			nextIndex: index,
		};
	}
	const next = argv[index + 1];
	if (next === undefined || next.startsWith('-')) {
		return { value: true, nextIndex: index };
	}
	return {
		value: parseBooleanValue(next, arg),
		nextIndex: index + 1,
	};
}

/** Preserve omission as undefined; repeated flags use the last supplied value. */
export function parseBooleanFlag(
	argv: string[],
	flag: string,
): boolean | undefined {
	let value: boolean | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== flag && !argv[i].startsWith(`${flag}=`)) continue;
		const parsed = parseBooleanOption(argv, i);
		value = parsed.value;
		i = parsed.nextIndex;
	}
	return value;
}
