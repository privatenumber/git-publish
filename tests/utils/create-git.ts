import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import spawn from 'nano-spawn';
import {
	createFixture, type FileTree, type FsFixture,
} from 'fs-fixture';
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

type Git = ReturnType<typeof createGit>;
type GitFixture = FsFixture & { git: Git };
type GitFixtureInitializer = (
	fixture: GitFixture,
) => FileTree | void | Promise<FileTree | void>;

export const createGitFixture = async (
	source?: FileTree | GitFixtureInitializer,
	initArguments?: string[],
) => {
	const fixture = await createFixture(async (fixture) => {
		const gitFixture = Object.assign(fixture, {
			git: createGit(fixture.path),
		});
		await gitFixture.git.init(initArguments);

		return typeof source === 'function'
			? source(gitFixture)
			: source;
	});

	return fixture as GitFixture;
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
