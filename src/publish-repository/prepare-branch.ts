import spawn, { SubprocessError } from 'nano-spawn';
import type { PublishRepository } from './create.ts';

export const loadPublishBranches = async (
	repository: PublishRepository,
	branches: {
		publishBranch: string;
		localRef: string;
	}[],
	fresh: boolean | undefined,
): Promise<Set<string>> => {
	const existing = new Set<string>();
	if (fresh) {
		return existing;
	}
	const { gitOptions, fetchRemoteName } = repository;
	let output: string;
	try {
		({ stdout: output } = await spawn('git', [
			'ls-remote',
			'--exit-code',
			'--branches',
			fetchRemoteName,
			...branches.map(({ publishBranch }) => `refs/heads/${publishBranch}`),
		], gitOptions));
	} catch (error) {
		if (error instanceof SubprocessError && error.exitCode === 2) {
			return existing;
		}
		throw error;
	}
	const references = new Set(output.split('\n').map(line => line.split('\t')[1]));
	const refspecs: string[] = [];
	for (const { publishBranch, localRef } of branches) {
		if (references.has(`refs/heads/${publishBranch}`)) {
			existing.add(publishBranch);
			refspecs.push(`refs/heads/${publishBranch}:${localRef}`);
		}
	}
	if (refspecs.length > 0) {
		await spawn('git', ['fetch', '--depth=1', '--no-tags', fetchRemoteName, ...refspecs], gitOptions);
	}
	return existing;
};
