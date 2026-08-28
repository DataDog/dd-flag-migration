import { describe, expect, it } from '@jest/globals';
import { render } from 'ink-testing-library';
import { HEADER_SUBTITLES, Header } from '../src/components/Header.js';

describe('Header', () => {
	it('renders the full banner including the given subtitle', () => {
		const { lastFrame } = render(
			<Header subtitle={HEADER_SUBTITLES.migrate} />,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Feature Flag Migration Tool');
		expect(frame).toContain('Migrate to Datadog');
		expect(frame).toContain('╔══════════════════════════════════════════╗');
		expect(frame).toContain('╚══════════════════════════════════════════╝');
	});

	it('varies the subtitle by provider', () => {
		const { lastFrame } = render(<Header subtitle={HEADER_SUBTITLES.eppo} />);
		expect(lastFrame() ?? '').toContain('Eppo → Datadog');
	});

	it('renders the get assignments subtitle', () => {
		const { lastFrame } = render(
			<Header subtitle={HEADER_SUBTITLES.getAssignments} />,
		);
		expect(lastFrame() ?? '').toContain('Get Precomputed Assignments');
	});
});
