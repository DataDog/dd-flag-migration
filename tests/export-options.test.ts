import { describe, expect, it, jest } from '@jest/globals';
import { shouldExportResults } from '../src/helpers/export.js';

describe('shouldExportResults', () => {
	it.each([
		true,
		false,
	])('prompts only for omission when interactive=%s', async (interactive) => {
		const prompt = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
		expect(await shouldExportResults(undefined, interactive, prompt)).toBe(
			interactive,
		);
		expect(prompt).toHaveBeenCalledTimes(interactive ? 1 : 0);
	});

	it('uses the answer when the user declines the prompt', async () => {
		const prompt = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
		expect(await shouldExportResults(undefined, true, prompt)).toBe(false);
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it.each([
		[true, true],
		[true, false],
		[false, true],
		[false, false],
	])('honors explicit value=%s without prompting (interactive=%s)', async (value, interactive) => {
		const prompt = jest.fn<() => Promise<boolean>>();
		expect(await shouldExportResults(value, interactive, prompt)).toBe(value);
		expect(prompt).not.toHaveBeenCalled();
	});
});
