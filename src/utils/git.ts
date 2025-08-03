import spawn, { type SubprocessError, type Options as SpawnOptions } from 'nano-spawn';

const simpleSpawn = async (
	command: string,
	args: string[],
	options?: SpawnOptions,
) => {
	const result = await spawn(command, args, options);
	return result.stdout.trim();
};

export const gitStatusTracked = (
	options?: SpawnOptions,
) => simpleSpawn('git', ['status', '--porcelain', '--untracked-files=no'], options);

export const assertCleanTree = async () => {
	const stdout = await gitStatusTracked().catch((error) => {
		if (error.stderr.includes('not a git repository')) {
			throw new Error('Not in a git repository');
		}

		throw error;
	});

	if (stdout) {
		throw new Error('Working tree is not clean');
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
