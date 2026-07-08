import { Box, Text, useApp } from 'ink';
import { useEffect } from 'react';

const PURPLE = '#632CA6';
const BORDER_TOP = '╔══════════════════════════════════════════╗';
const BORDER_BOTTOM = '╚══════════════════════════════════════════╝';
const SIDE = '║';
const TITLE = '   🚩  Feature Flag Migration Tool  🚩    ';

export type HeaderProps = {
	subtitle: string;
	exitOnRender?: boolean;
};

/**
 * Prints the shared purple banner. `subtitle` is the second line inside the
 * box (e.g. "Migrate to Datadog", "Eppo → Datadog"). Callers should ensure
 * `subtitle` is exactly 42 characters wide (padded with spaces). Set
 * `exitOnRender=false` when composing Header inside another static screen.
 */
export const Header = ({
	subtitle,
	exitOnRender = true,
}: HeaderProps): JSX.Element => {
	const { exit } = useApp();
	useEffect(() => {
		if (exitOnRender) exit();
	}, [exit, exitOnRender]);
	const items: Array<{ id: string; render: () => JSX.Element }> = [
		{ id: 'blank-top', render: () => <Text> </Text> },
		{
			id: 'border-top',
			render: () => (
				<Text bold color={PURPLE}>
					{BORDER_TOP}
				</Text>
			),
		},
		{
			id: 'title',
			render: () => (
				<Text>
					<Text bold color={PURPLE}>
						{SIDE}
					</Text>
					<Text bold color="white">
						{TITLE}
					</Text>
					<Text bold color={PURPLE}>
						{SIDE}
					</Text>
				</Text>
			),
		},
		{
			id: 'subtitle',
			render: () => (
				<Text>
					<Text bold color={PURPLE}>
						{SIDE}
					</Text>
					<Text color={PURPLE}>{subtitle}</Text>
					<Text bold color={PURPLE}>
						{SIDE}
					</Text>
				</Text>
			),
		},
		{
			id: 'border-bottom',
			render: () => (
				<Text bold color={PURPLE}>
					{BORDER_BOTTOM}
				</Text>
			),
		},
		{ id: 'blank-bottom', render: () => <Text> </Text> },
	];
	return (
		<Box flexDirection="column">
			{items.map((item) => (
				<Box key={item.id}>{item.render()}</Box>
			))}
		</Box>
	);
};

// Subtitle constants, padded to the interior width (42 chars).
export const HEADER_SUBTITLES = {
	migrate: '            Migrate to Datadog            ',
	eppo: '              Eppo → Datadog              ',
	launchdarkly: '          LaunchDarkly → Datadog          ',
	evaluate: '           Evaluate Migration             ',
} as const;
