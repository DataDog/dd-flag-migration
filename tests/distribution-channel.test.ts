import { describe, expect, it } from '@jest/globals';
import { resolveDistributionChannel } from '../src/helpers/distribution-channel.js';

describe('resolveDistributionChannel', () => {
	it('preserves the Datadog default or existing channel in auto mode', () => {
		expect(resolveDistributionChannel('auto')).toBeUndefined();
	});

	it.each([
		['client', 'CLIENT'],
		['server', 'SERVER'],
		['all', 'BOTH'],
	] as const)('maps explicit %s mode to %s', (mode, expected) => {
		expect(resolveDistributionChannel(mode)).toBe(expected);
	});
});
