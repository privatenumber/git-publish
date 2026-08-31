import type { Options as SpawnOptions } from 'nano-spawn';
import { simpleSpawn } from './simple-spawn.ts';

export const gitStatusTracked = (
	options?: SpawnOptions,
) => simpleSpawn('git', ['status', '--porcelain', '--untracked-files=no'], options);

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
	const branch = await simpleSpawn('git', ['branch', '--show-current']);
	if (branch) {
		return branch;
	}

	const tag = await simpleSpawn('git', ['describe', '--tags', '--exact-match']).catch(() => {
		// Git exits with 128 when HEAD has no exact tag.
	});
	return tag || simpleSpawn('git', ['rev-parse', '--short', 'HEAD']);
};

export const getCurrentCommit = async (
	options?: SpawnOptions,
) => (
	// Can be empty if new git repository with no commits
	simpleSpawn('git', ['rev-parse', '--short', 'HEAD'], options).catch(() => {})
);
