import { describe, expect, it } from '@jest/globals';
import { resolveDistributionChannel } from '../src/helpers/distribution-channel.js';

describe('resolveDistributionChannel', () => {
	it('uses CLIENT in auto mode when semver targeting is present', () => {
		expect(resolveDistributionChannel('auto', true)).toBe('CLIENT');
	});

	it('preserves the Datadog default or existing channel in auto mode without semver', () => {
		expect(resolveDistributionChannel('auto', false)).toBeUndefined();
	});

	it.each([
		['client', 'CLIENT'],
		['server', 'SERVER'],
		['all', 'BOTH'],
	] as const)('maps explicit %s mode to %s', (mode, expected) => {
		expect(resolveDistributionChannel(mode, false)).toBe(expected);
		expect(resolveDistributionChannel(mode, true)).toBe(expected);
	});
});
