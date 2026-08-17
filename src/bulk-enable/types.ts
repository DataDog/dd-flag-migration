export type BulkEnableStatus =
	| 'Enabled'
	| 'Enabled (prior status unknown)'
	| 'Already enabled'
	| 'Approval requested'
	| 'Approval requested (prior status unknown)'
	| 'Failed';

export interface BulkEnableResult {
	flagId: string;
	flagKey: string;
	flagTags: string[];
	environmentId: string;
	environmentName: string;
	isProduction: boolean;
	status: BulkEnableStatus;
	statusLookupError?: string;
	error?: string;
}
