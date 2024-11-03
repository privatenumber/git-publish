import path from 'node:path';
import { execa } from 'execa';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit } from './utils/create-git.js';

const gitPublish = path.resolve('./dist/index.js');

describe('git-publish', ({ describe }) => {
	describe('Error cases', ({ test }) => {
		test('Fails if not in git repository', async () => {
			await using fixture = await createFixture();

			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Not in a git repository');
		});

		test('Fails if no package.json found', async () => {
			await using fixture = await createFixture();

			await createGit(fixture.path);

			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory');
		});

		test('Dirty working tree', async () => {
			await using fixture = await createFixture({
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
		});
	});

	describe('Current project', async ({ test }) => {
		await using fixture = await createFixture(process.cwd(), {
			templateFilter: cpPath => !(
				cpPath.endsWith(`${path.sep}node_modules`)
				|| path.basename(cpPath).startsWith('.')
				|| path.basename(cpPath) === 'dist'
			),
		});

		const git = await createGit(fixture.path);
		await git('add', ['.']);
		await git('commit', ['-am', 'Initial commit']);

		await test('Errors on missing remote', async () => {
			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Git remote "origin" does not exist');
		});

		const { stdout: originRemote } = await execa('git', ['remote', 'get-url', 'origin']);
		await git('remote', ['add', 'origin', originRemote]);

		await test('Publishes', async ({ onTestFail }) => {
			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			onTestFail(async () => {
				console.log(gitPublishProcess);
				const ls = await execa('ls', ['-R'], {
					cwd: fixture.path,
				});
				console.log(ls);
			});

			expect(gitPublishProcess.exitCode).toBe(0);
			expect(gitPublishProcess.stdout).toMatch('✔');
		});
	});
});
