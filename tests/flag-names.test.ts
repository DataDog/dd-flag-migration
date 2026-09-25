import { describe, expect, it } from '@jest/globals';
import { resolveFlagNameForSync } from '../src/datadog/flag-names.js';

describe('collision-resolved flag names', () => {
	it.each([
		['Checkout', 'Checkout (1)', 'Checkout (1)'],
		['Checkout', 'Checkout (9)', 'Checkout (9)'],
		['Checkout (test)', 'Checkout (test) (2)', 'Checkout (test) (2)'],
		['New checkout', 'Old checkout (1)', 'New checkout'],
		['Checkout', 'Checkout (01)', 'Checkout'],
		['Checkout', 'Checkout (0)', 'Checkout'],
		['Checkout', 'Checkout (10)', 'Checkout'],
		['Checkout', 'Checkout (1) extra', 'Checkout'],
		['Checkout', undefined, 'Checkout'],
	])('resolves %s with current name %s', (source, current, expected) => {
		expect(resolveFlagNameForSync(source, current)).toBe(expected);
	});
});
