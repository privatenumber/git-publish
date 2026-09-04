import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import spawn from 'nano-spawn';
import { createFixture, type FileTree } from 'fs-fixture';
import { getStdout } from '../../src/utils/get-stdout.ts';

export const createGit = (
	cwd: string,
) => {
	const git = async (
		command: string,
		args?: string[],
	) => getStdout(spawn(
		'git',
		[command, ...(args || [])],
		{ cwd },
	));

	return Object.assign(git, {
		init: async (args: string[] = []) => {
			await git('init', args);
			await git('config', ['user.name', 'name']);
			await git('config', ['user.email', 'email']);
		},
	});
};

export const createGitFixture = async (
	files?: FileTree,
	initArguments?: string[],
) => {
	const fixture = await createFixture(files);
	const git = createGit(fixture.path);
	try {
		await git.init(initArguments);
	} catch (error) {
		// Preserve the Git error if removing the incomplete fixture also fails.
		await fixture.rm().catch(() => undefined);
		throw error;
	}

	return Object.assign(fixture, { git });
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
