import { Box, Text } from 'ink';
import { cloneElement } from 'react';
import { HEADER_SUBTITLES, Header } from './Header.js';

type HelpItem = { id: string; render: () => JSX.Element };

export function HelpScreen(): JSX.Element {
	const items: HelpItem[] = [
		{
			id: 'usage',
			render: () => (
				<Text>
					<Text bold>Usage:</Text> dd-flag-migration &lt;command&gt; [options]
				</Text>
			),
		},
		{ id: 'space-usage', render: () => <Text> </Text> },
		{ id: 'global-title', render: () => <Text bold>Global options:</Text> },
		{
			id: 'version',
			render: () => (
				<Text>
					{'  '}
					<Text color="cyan">-V, --version</Text>
					{'               Print version and exit'}
				</Text>
			),
		},
		{
			id: 'help',
			render: () => (
				<Text>
					{'  '}
					<Text color="cyan">-h, --help</Text>
					{'                  Show this help message'}
				</Text>
			),
		},
		{ id: 'space-global', render: () => <Text> </Text> },
		{ id: 'commands-title', render: () => <Text bold>Commands:</Text> },
		{
			id: 'migrate-command',
			render: () => (
				<Text>
					{'  '}
					<Text color="cyan">migrate</Text>
					{'    Migrate feature flags from Eppo or LaunchDarkly into Datadog'}
				</Text>
			),
		},
		{
			id: 'evaluate-command',
			render: () => (
				<Text>
					{'  '}
					<Text color="cyan">evaluate</Text>
					{'   Compare flag evaluations side-by-side after migrating'}
				</Text>
			),
		},
		{
			id: 'advanced-permissions-command',
			render: () => (
				<Text>
					{'  '}
					<Text color="cyan">advanced-permissions</Text>
					{'   Add or remove team permissions on migrated flags'}
				</Text>
			),
		},
		{ id: 'space-commands', render: () => <Text> </Text> },
		{
			id: 'migrate-title',
			render: () => (
				<Text>
					<Text bold>Options for</Text> <Text color="cyan">migrate</Text>:
				</Text>
			),
		},
		{
			id: 'dry-run',
			render: () => (
				<Text>
					{
						'  --dry-run                    Preview changes without creating flags'
					}
				</Text>
			),
		},
		{
			id: 'migrate-site',
			render: () => (
				<Text>
					{
						'  --datadog-site=<site>        Set the Datadog site non-interactively'
					}
				</Text>
			),
		},
		{
			id: 'interactive',
			render: () => (
				<Text>
					{
						'  --interactive=<bool>         Set to false to run without prompts (default: true)'
					}
				</Text>
			),
		},
		{
			id: 'export',
			render: () => (
				<Text>
					{
						'  --export=<bool>              Non-interactive only: export results to xlsx (default: false)'
					}
				</Text>
			),
		},
		{ id: 'space-migrate', render: () => <Text> </Text> },
		{
			id: 'required-title',
			render: () => (
				<Text>
					<Text bold>Required when</Text>{' '}
					<Text color="cyan">--interactive=false</Text>:
				</Text>
			),
		},
		{
			id: 'json-note',
			render: () => (
				<Text>
					{
						'  Output is a JSON result document on stdout; status logs go to stderr.'
					}
				</Text>
			),
		},
		{
			id: 'provider',
			render: () => (
				<Text>
					{
						'  --provider <Eppo|LaunchDarkly>   Source feature flag provider (case-insensitive)'
					}
				</Text>
			),
		},
		{
			id: 'env-map',
			render: () => (
				<Text>
					{
						'  --env-map <source,target>        Map a source env to a Datadog env (repeatable; ≥1)'
					}
				</Text>
			),
		},
		{
			id: 'feature-flag',
			render: () => (
				<Text>
					{
						'  --feature-flag <key>[,<dd-key>]  Flag key to migrate; LaunchDarkly may include a Datadog rename (repeatable; ≥1)'
					}
				</Text>
			),
		},
		{
			id: 'project',
			render: () => (
				<Text>
					{
						'  --project <key>                  LaunchDarkly project key (LaunchDarkly only)'
					}
				</Text>
			),
		},
		{ id: 'space-required', render: () => <Text> </Text> },
		{
			id: 'evaluate-title',
			render: () => (
				<Text>
					<Text bold>Options for</Text> <Text color="cyan">evaluate</Text>:
				</Text>
			),
		},
		{
			id: 'latest',
			render: () => (
				<Text>
					{
						'  --use-latest-migration       Skip migration file selector; use most recent'
					}
				</Text>
			),
		},
		{
			id: 'subject',
			render: () => (
				<Text>
					{
						'  --test-subject-id=<id>       Set the subject ID non-interactively'
					}
				</Text>
			),
		},
		{
			id: 'flag-env',
			render: () => (
				<Text>
					{
						'  --flag-environment=<name>    Set the Datadog environment non-interactively'
					}
				</Text>
			),
		},
		{
			id: 'evaluate-site',
			render: () => (
				<Text>
					{
						'  --datadog-site=<site>        Set the Datadog site non-interactively'
					}
				</Text>
			),
		},
		{
			id: 'csv',
			render: () => (
				<Text>
					{
						'  --csv=<path>                 Path to a CSV file for advanced evaluation'
					}
				</Text>
			),
		},
		{
			id: 'show-table',
			render: () => (
				<Text>
					{
						'  --show-table                 Force table output even for large result sets'
					}
				</Text>
			),
		},
		{ id: 'space-evaluate', render: () => <Text> </Text> },
		{ id: 'examples-title', render: () => <Text bold>Examples:</Text> },
		{
			id: 'example-migrate',
			render: () => (
				<Text>
					{'  '}
					<Text color="gray">$</Text> dd-flag-migration migrate
				</Text>
			),
		},
		{
			id: 'example-dry-run',
			render: () => (
				<Text>
					{'  '}
					<Text color="gray">$</Text> dd-flag-migration migrate --dry-run
				</Text>
			),
		},
		{
			id: 'example-noninteractive-1',
			render: () => (
				<Text>
					{'  '}
					<Text color="gray">$</Text>{' '}
					{'dd-flag-migration migrate --interactive=false \\'}
				</Text>
			),
		},
		{
			id: 'example-noninteractive-2',
			render: () => (
				<Text>
					{'      --provider LaunchDarkly --project my-ld-project \\'}
				</Text>
			),
		},
		{
			id: 'example-noninteractive-3',
			render: () => <Text>{'      --datadog-site datadoghq.com \\'}</Text>,
		},
		{
			id: 'example-noninteractive-4',
			render: () => (
				<Text>
					{'      --env-map Production,Production --env-map Staging,QA \\'}
				</Text>
			),
		},
		{
			id: 'example-noninteractive-5',
			render: () => (
				<Text>{'      --feature-flag flag-one --feature-flag flag-two'}</Text>
			),
		},
		{
			id: 'example-evaluate',
			render: () => (
				<Text>
					{'  '}
					<Text color="gray">$</Text> dd-flag-migration evaluate
				</Text>
			),
		},
		{
			id: 'example-advanced-permissions',
			render: () => (
				<Text>
					{'  '}
					<Text color="gray">$</Text> dd-flag-migration advanced-permissions
				</Text>
			),
		},
		{
			id: 'example-evaluate-latest',
			render: () => (
				<Text>
					{'  '}
					<Text color="gray">$</Text>{' '}
					{
						'dd-flag-migration evaluate --use-latest-migration --datadog-site=datadoghq.com'
					}
				</Text>
			),
		},
		{ id: 'space-end', render: () => <Text> </Text> },
	];

	return (
		<Box flexDirection="column">
			<Header subtitle={HEADER_SUBTITLES.migrate} />
			{items.map((item) => (
				<Box key={item.id}>
					{cloneElement(item.render(), { wrap: 'truncate' })}
				</Box>
			))}
		</Box>
	);
}
