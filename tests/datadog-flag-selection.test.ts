import { describe, expect, it } from '@jest/globals';
import stripAnsi from 'strip-ansi';
import { datadogFlagSearchTerms } from '../src/datadog-migration/flag-selection.js';
import { orgFlagLinkPresence, orgFlagLinkTags } from '../src/org-diff/index.js';

describe('Datadog flag selection', () => {
	it('searches by name, key, and every tag', () => {
		expect(
			datadogFlagSearchTerms({
				name: 'Example Flag',
				key: 'example-flag',
				tags: ['team:example', 'service:web'],
			}),
		).toEqual(['Example Flag', 'example-flag', 'team:example', 'service:web']);
	});

	it('merges tags from both orgs for comparison links', () => {
		expect(
			orgFlagLinkTags({
				key: 'example-flag',
				source: { id: 's', key: 'example-flag', tags: ['team:a', 'env:x'] },
				target: { id: 't', key: 'example-flag', tags: ['team:a', 'team:b'] },
			}),
		).toEqual(['team:a', 'env:x', 'team:b']);
	});

	it('labels which org a comparison link exists in', () => {
		const source = { id: 's', key: 'k' };
		const target = { id: 't', key: 'k' };
		const presence = (link: Parameters<typeof orgFlagLinkPresence>[0]) => {
			const { category, badge } = orgFlagLinkPresence(link);
			return [category, stripAnsi(badge)];
		};
		expect(presence({ key: 'k', source, target })).toEqual([
			'in-both-orgs',
			'both orgs',
		]);
		expect(presence({ key: 'k', source })).toEqual([
			'only-in-source',
			'source org only',
		]);
		expect(presence({ key: 'k', target })).toEqual([
			'only-in-target',
			'target org only',
		]);
	});
});
