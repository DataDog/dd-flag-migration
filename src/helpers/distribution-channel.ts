import { select } from '../components/Select.js';

export type DistributionChannelMode = 'auto' | 'client' | 'server' | 'all';
export type DatadogDistributionChannel = 'CLIENT' | 'SERVER' | 'BOTH';

const EXPLICIT_CHANNELS: Record<
	Exclude<DistributionChannelMode, 'auto'>,
	DatadogDistributionChannel
> = {
	client: 'CLIENT',
	server: 'SERVER',
	all: 'BOTH',
};

export function resolveDistributionChannel(
	mode: DistributionChannelMode,
	hasSemverTargeting: boolean,
): DatadogDistributionChannel | undefined {
	if (mode === 'auto') {
		return hasSemverTargeting ? 'CLIENT' : undefined;
	}

	return EXPLICIT_CHANNELS[mode];
}

export async function selectDistributionChannelMode(): Promise<DistributionChannelMode> {
	return select<DistributionChannelMode>({
		message: 'How should the Datadog distribution channel be configured?',
		default: 'auto',
		choices: [
			{
				name: 'Auto — use Client for semver targeting; preserve/default otherwise',
				value: 'auto',
				short: 'Auto',
			},
			{
				name: 'Client — make all selected flags available to client SDKs',
				value: 'client',
				short: 'Client',
			},
			{
				name: 'Server — make all selected flags available to server SDKs',
				value: 'server',
				short: 'Server',
			},
			{
				name: 'All — make all selected flags available to client and server SDKs',
				value: 'all',
				short: 'All',
			},
		],
	});
}
