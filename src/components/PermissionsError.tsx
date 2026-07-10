import { Box, Text } from 'ink';

type PermissionsErrorProps = {
	missing: readonly string[];
};

export function PermissionsError({
	missing,
}: PermissionsErrorProps): JSX.Element {
	const items = [
		{
			id: 'title',
			text: 'Missing required Datadog permissions:',
		},
		...missing.map((permission) => ({
			id: `permission-${permission}`,
			text: `  • ${permission}`,
		})),
		{
			id: 'blank',
			text: ' ',
		},
		{
			id: 'detail',
			text: 'Ensure your Datadog application key has the required permissions and try again.',
		},
		{
			id: 'end',
			text: ' ',
		},
	];

	return (
		<Box flexDirection="column">
			{items.map((item) => (
				<Box key={item.id}>
					<Text color="red">{item.text}</Text>
				</Box>
			))}
		</Box>
	);
}
