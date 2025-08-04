import type { SubprocessError, Options as SpawnOptions } from 'nano-spawn';
import { simpleSpawn } from './simple-spawn.js';

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

export const getCurrentBranchOrTagName = async () => {
	try {
		return await simpleSpawn(
			'git',
			['branch', '--show-current'],
		);
	} catch (error) {
		try {
			// Fallback to describing the tag/commit if not on a branch
			return await simpleSpawn(
				'git',
				['describe', '--tags'],
			);
		} catch (fallbackError) {
			throw new Error(`Failed to get current branch name: ${(error as SubprocessError).stderr} ${(fallbackError as SubprocessError).stderr}`);
		}
	}
};

export const getCurrentCommit = async (
	options?: SpawnOptions,
) => (
	// Can be empty if new git repository with no commits
	simpleSpawn('git', ['rev-parse', '--short', 'HEAD'], options).catch(() => {})
);
