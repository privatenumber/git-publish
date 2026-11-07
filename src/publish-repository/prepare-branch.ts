import spawn, { SubprocessError } from 'nano-spawn';
import type { PublishRepository } from './create.ts';

export const loadPublishBranches = async (
	repository: PublishRepository,
	branches: {
		publishBranch: string;
		localBranch: string;
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
	for (const { publishBranch, localBranch } of branches) {
		if (references.has(`refs/heads/${publishBranch}`)) {
			existing.add(publishBranch);
			refspecs.push(`refs/heads/${publishBranch}:refs/heads/${localBranch}`);
		}
	}
	if (refspecs.length > 0) {
		await spawn('git', ['fetch', '--depth=1', '--no-tags', fetchRemoteName, ...refspecs], gitOptions);
	}
	return existing;
};

export const preparePublishBranch = async ({
	repository,
	localBranch,
	orphan,
}: {
	repository: PublishRepository;
	localBranch: string;
	orphan: boolean;
}) => {
	const { gitOptions } = repository;
	if (orphan) {
		// Fresh orphan branch with no history
		await spawn('git', ['checkout', '--orphan', localBranch], gitOptions);
	} else {
		// Repoint HEAD to the fetched branch without checkout
		await spawn('git', ['symbolic-ref', 'HEAD', `refs/heads/${localBranch}`], gitOptions);
	}

	// Remove all files from index and working directory

	// removes tracked files from index (.catch() since it fails on empty orphan branches)
	await spawn('git', ['rm', '--cached', '-r', ':/'], gitOptions).catch(() => {});

	// removes all untracked files from the working directory
	await spawn('git', ['clean', '-fdx'], gitOptions);
};
