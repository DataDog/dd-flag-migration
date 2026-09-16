import { describe, expect, it } from '@jest/globals';
import { mapWithConcurrency } from '../src/helpers/concurrency.js';

describe('mapWithConcurrency', () => {
	it('preserves input order while bounding active work', async () => {
		let active = 0;
		let maximumActive = 0;
		const result = await mapWithConcurrency([3, 1, 2, 0], 2, async (value) => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, value));
			active--;
			return value * 2;
		});
		expect(result).toEqual([6, 2, 4, 0]);
		expect(maximumActive).toBeLessThanOrEqual(2);
	});

	it('rejects invalid limits', async () => {
		await expect(
			mapWithConcurrency([1], 0, async (value) => value),
		).rejects.toThrow('Concurrency limit must be a positive integer');
	});
});
