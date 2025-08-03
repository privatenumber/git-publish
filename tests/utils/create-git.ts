import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import spawn from 'nano-spawn';

export const createGit = (
	cwd: string,
) => {
	const git = async (
		command: string,
		args?: string[],
	) => {
		const result = await spawn(
			'git',
			[command, ...(args || [])],
			{ cwd },
		);
		return result.stdout.trim();
	};

	return Object.assign(git, {
		init: async () => {
			await git(
				'init',
				[
					// In case of different default branch name
					'--initial-branch=master',
				],
			);
			await git('config', ['user.name', 'name']);
			await git('config', ['user.email', 'email']);
		},
	});
};

export const gitWorktree = async (
	repoPath: string,
	branchName: string,
) => {
	const workingDirectory = path.join(os.tmpdir(), `git-publish-test-${Date.now()}`);

	const gitCurrent = createGit(repoPath);
	await gitCurrent('worktree', ['add', workingDirectory, '--force', branchName]);
	await fs.symlink(path.resolve('node_modules'), path.join(workingDirectory, 'node_modules'), 'dir');

	return {
		path: workingDirectory,
		git: createGit(workingDirectory),
		[Symbol.asyncDispose]: async () => {
			await gitCurrent('worktree', ['remove', '--force', workingDirectory]);
		},
	};
};
