import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from './get-stdout.ts';

export const gitStatusTracked = (
	options?: SpawnOptions,
) => getStdout(spawn('git', ['status', '--porcelain', '--untracked-files=no'], options));

export const assertCleanTree = async () => {
	const stdout = await gitStatusTracked().catch((error) => {
		if (error.stderr.includes('not a git repository')) {
			throw new Error('Not in a git repository.');
		}

		throw error;
	});

	if (stdout) {
		throw new Error('The working tree is not clean. Please commit or stash your changes before publishing.');
	}
};

export const getCurrentSourceName = async () => {
	const branch = await getStdout(spawn('git', ['branch', '--show-current']));
	if (branch) {
		return branch;
	}

	const tag = await getStdout(spawn('git', ['describe', '--tags', '--exact-match'])).catch(() => {
		// Git exits with 128 when HEAD has no exact tag.
	});
	if (tag) {
		return tag;
	}

	return await getStdout(spawn('git', ['rev-parse', '--short', 'HEAD']));
};

export const getCurrentCommit = async (
	options?: SpawnOptions,
): Promise<string | undefined> => (
	// Can be empty if new git repository with no commits
	getStdout(spawn('git', ['rev-parse', '--short', 'HEAD'], options)).catch(() => undefined)
);

export const getCurrentCommitId = async (
	options?: SpawnOptions,
): Promise<string | undefined> => (
	// Can be empty if new git repository with no commits
	getStdout(spawn('git', ['rev-parse', 'HEAD'], options)).catch(() => undefined)
);
