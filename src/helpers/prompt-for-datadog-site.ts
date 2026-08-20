import chalk from 'chalk';
import { confirm } from '../components/Confirm.js';
import { input } from '../components/Input.js';
import { getDatadogSite, saveDatadogSite } from './config.js';

export async function promptForDatadogSite(
	datadogSiteArg?: string,
): Promise<string> {
	if (datadogSiteArg !== undefined) {
		console.log(
			chalk.gray(`  Using Datadog site: ${chalk.cyan(datadogSiteArg)}\n`),
		);
		return datadogSiteArg;
	}

	const envSite = process.env.DD_SITE?.trim();
	if (!envSite) {
		const stored = getDatadogSite();
		if (stored) {
			const useStored = await confirm({
				message: `Use your saved Datadog site (${stored})?`,
				default: true,
			});
			if (useStored) return stored;
		}
	}

	console.log(
		chalk.gray('  (e.g. "datadoghq.com", "datadoghq.eu", "us5.datadoghq.com")'),
	);
	const site = await input({
		message: 'Which Datadog site does your org use?',
		default: envSite ?? 'datadoghq.com',
		hint: envSite
			? 'Pre-filled from DD_SITE environment variable; press Enter to accept this value.'
			: undefined,
		validate: (value) =>
			value.trim().length > 0 ? true : 'Site cannot be empty',
	});

	const trimmed = site.trim();
	saveDatadogSite(trimmed);
	console.log(chalk.gray('  Site saved for future sessions.\n'));
	return trimmed;
}
