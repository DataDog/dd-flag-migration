/** Creation and re-sync use the same bounded display-name collision policy. */
export const MAX_FLAG_NAME_SUFFIX = 9;

export function flagNameCandidate(name: string, attempt: number): string {
	return attempt === 0 ? name : `${name} (${attempt})`;
}

/** Preserve legacy collision suffixes without suppressing real source renames. */
export function resolveFlagNameForSync(
	sourceName: string,
	currentName?: string,
): string {
	for (let attempt = 1; attempt <= MAX_FLAG_NAME_SUFFIX; attempt++) {
		if (currentName === flagNameCandidate(sourceName, attempt))
			return currentName;
	}
	return sourceName;
}
