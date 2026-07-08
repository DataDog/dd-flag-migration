import { format } from 'node:util';

export async function withConsoleLogToStderr<T>(
	fn: () => Promise<T>,
): Promise<T> {
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		process.stderr.write(`${format(...args)}\n`);
	};
	try {
		return await fn();
	} finally {
		console.log = originalLog;
	}
}

export function writeJsonOutput(data: unknown): void {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}
