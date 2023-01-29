import path from 'path';
import { execa, type Options } from 'execa';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';

const gitPublish = path.resolve('./dist/index.js');

const createGit = async (cwd: string) => {
	const git = (
		command: string,
		args?: string[],
		options?: Options,
	) => (
		execa(
			'git',
			[command, ...(args || [])],
			{
				cwd,
				...options,
			},
		)
	);

	await git(
		'init',
		[
			// In case of different default branch name
			'--initial-branch=master',
		],
	);

	await git('config', ['user.name', 'name']);
	await git('config', ['user.email', 'email']);

	return git;
};

describe('git-publish', ({ describe, test }) => {
	describe('Error cases', ({ test }) => {
		test('Fails if not in git repository', async () => {
			const fixture = await createFixture();

			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Not in a git repository');

			await fixture.rm();
		});

		test('Fails if no package.json found', async () => {
			const fixture = await createFixture();

			await createGit(fixture.path);

			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory');

			await fixture.rm();
		});

		test('Dirty working tree', async () => {
			const fixture = await createFixture({
				'package.json': '{}',
			});

			const git = await createGit(fixture.path);
			await git('add', ['package.json']);

			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Working tree is not clean');

			await fixture.rm();
		});
	});

	test('Publishes', async ({ onTestFail }) => {
		await execa('git', ['config', 'user.name', 'GitHub Actions']);
		await execa('git', ['config', 'user.email', '<>']);

		const gitPublishProcess = await execa(gitPublish, {
			reject: false,
		});

		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect(gitPublishProcess.exitCode).toBe(0);
		expect(gitPublishProcess.stderr).toBe('');
		expect(gitPublishProcess.stdout).toMatch('✔');
	});
});
