import spawn, { SubprocessError } from 'nano-spawn';
import type { PublishRepository } from './create.ts';

export const preparePublishBranch = async ({
	repository,
	publishBranch,
	localBranch,
	fresh,
	worktreePath,
}: {
	repository: PublishRepository;
	publishBranch: string;
	localBranch: string;
	fresh: boolean | undefined;
	worktreePath?: string;
}) => {
	const { gitOptions, fetchRemoteName } = repository;

	let orphan = false;
	if (fresh) {
		orphan = true;
	} else {
		try {
			await spawn('git', [
				'ls-remote',
				'--exit-code',
				'--branches',
				fetchRemoteName,
				`refs/heads/${publishBranch}`,
			], gitOptions);
		} catch (error) {
			if (!(error instanceof SubprocessError) || error.exitCode !== 2) {
				throw error;
			}

			orphan = true;
		}

		if (!orphan) {
			await spawn('git', [
				'fetch',
				'--depth=1',
				'--no-tags',
				fetchRemoteName,
				`${publishBranch}:${localBranch}`,
			], gitOptions);
		}
	}

	const worktreeOptions = worktreePath
		? {
			cwd: worktreePath,
			env: gitOptions.env,
		}
		: gitOptions;
	if (worktreePath) {
		// A linked worktree starts from the fetched branch, or from the
		// shared HEAD when preparing an orphan branch.
		await spawn('git', ['worktree', 'add', '--force', worktreePath, orphan ? 'HEAD' : localBranch], gitOptions);
	}

	if (orphan) {
		// Fresh orphan branch with no history
		await spawn('git', ['checkout', '--orphan', localBranch], worktreeOptions);
	} else {
		// Repoint HEAD to the fetched branch without checkout
		await spawn('git', ['symbolic-ref', 'HEAD', `refs/heads/${localBranch}`], worktreeOptions);
	}

	// Remove all files from index and working directory

	// removes tracked files from index (.catch() since it fails on empty orphan branches)
	await spawn('git', ['rm', '--cached', '-r', ':/'], worktreeOptions).catch(() => {});

	// removes all untracked files from the working directory
	await spawn('git', ['clean', '-fdx'], worktreeOptions);
};
