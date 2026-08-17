export type PermissionOperation = 'add' | 'remove';

export type PermissionChangeStatus =
	| 'Added'
	| 'Removed'
	| 'Already present'
	| 'Not present'
	| 'Failed';

export interface PermissionChangeResult {
	flagId: string;
	flagKey: string;
	flagTags: string[];
	teamId: string;
	teamName: string;
	teamHandle: string;
	operation: PermissionOperation;
	status: PermissionChangeStatus;
	error?: string;
}
