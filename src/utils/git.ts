import spawn, { SubprocessError, type Options as SpawnOptions } from 'nano-spawn';
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

export const getSourceCommit = async () => {
	const ref = await getStdout(spawn('git', ['symbolic-ref', '-q', 'HEAD'])).catch((error: unknown) => {
		if (error instanceof SubprocessError && error.exitCode === 1) {
			return undefined;
		}
		throw error;
	});
	// Resolving the captured ref keeps the branch name and commit aligned if HEAD switches.
	const commit = await getStdout(spawn('git', ['rev-parse', '--verify', '--quiet', `${ref ?? 'HEAD'}^{commit}`])).catch((error: unknown) => {
		if (error instanceof SubprocessError && error.exitCode === 1) {
			throw new Error('The repository has no commits. Commit your changes before publishing.');
		}
		throw error;
	});
	return {
		ref,
		commit,
	};
};

export const getCurrentSourceName = async (
	ref: string | undefined,
	sourceCommitId: string,
	sourceCommit: string,
) => {
	if (ref) {
		return ref.replace(/^refs\/heads\//, '');
	}

	const tag = await getStdout(spawn('git', ['describe', '--tags', '--exact-match', sourceCommitId])).catch(() => {
		// Git exits with 128 when the commit has no exact tag.
	});
	if (tag) {
		return tag;
	}

	return sourceCommit;
};
