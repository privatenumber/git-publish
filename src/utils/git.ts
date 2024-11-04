import { execa } from 'execa';

export const gitStatusTracked = () => execa('git', ['status', '--porcelain', '--untracked-files=no']);

export const assertCleanTree = async () => {
	const { stdout } = await gitStatusTracked().catch((error) => {
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
	/**
	 * This commands supports older versions of Git, but since v2.22, you can do:
	 * git branch --show-current
	 */
	const getBranch = await execa(
		'git',
		['symbolic-ref', '--short', '-q', 'HEAD'],
		{ reject: false },
	);

	if (getBranch.stdout) {
		return getBranch.stdout;
	}

	const getTag = await execa(
		'git',
		['describe', '--tags'],
		{ reject: false },
	);

	if (getTag.stdout) {
		return getTag.stdout;
	}

	throw new Error(`Failed to get current branch name: ${getBranch.stderr} ${getTag.stderr}`);
};
