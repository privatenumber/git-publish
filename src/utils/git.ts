import spawn, { type SubprocessError } from 'nano-spawn';

export const gitStatusTracked = () => spawn('git', ['status', '--porcelain', '--untracked-files=no']);

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
	const getBranch = await spawn(
		'git',
		['symbolic-ref', '--short', '-q', 'HEAD'],
	).catch(error => error as SubprocessError);

	if (getBranch.stdout) {
		return getBranch.stdout;
	}

	const getTag = await spawn(
		'git',
		['describe', '--tags'],
	).catch(error => error as SubprocessError);

	if (getTag.stdout) {
		return getTag.stdout;
	}

	throw new Error(`Failed to get current branch name: ${getBranch.stderr} ${getTag.stderr}`);
};

export const getCurrentCommit = async () => {
	const getCommit = await spawn('git', ['rev-parse', '--short', 'HEAD']);
	return getCommit.stdout.trim();
};
