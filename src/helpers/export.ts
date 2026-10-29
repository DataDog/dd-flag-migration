/** Explicit choices skip the prompt; omission preserves the command's UI. */
export async function shouldExportResults(
	value: boolean | undefined,
	interactive: boolean,
	prompt: () => Promise<boolean>,
): Promise<boolean> {
	if (value !== undefined) return value;
	return interactive ? prompt() : false;
}
