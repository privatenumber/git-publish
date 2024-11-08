import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit } from './utils/create-git.js';
import { gitPublish } from './utils/git-publish.js';

describe('git-publish', ({ describe, test }) => {
	describe('Error cases', ({ test }) => {
		test('Fails if not in git repository', async () => {
			await using fixture = await createFixture();

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Not in a git repository');
		});

		test('Fails if no package.json found', async () => {
			await using fixture = await createFixture();

			await createGit(fixture.path);

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory');
		});

		test('Dirty working tree', async () => {
			await using fixture = await createFixture({
				'package.json': '{}',
			});

			const git = await createGit(fixture.path);
			await git('add', ['package.json']);

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Working tree is not clean');
		});
	});

	test('Publishes', async ({ onTestFail }) => {
		const fixture = await createFixture(process.cwd(), {
			templateFilter: cpPath => !(
				cpPath.endsWith(`${path.sep}node_modules`)
				|| path.basename(cpPath) === '.git'
				|| path.basename(cpPath) === 'dist'
			),
		});

		await fs.symlink(path.resolve('node_modules'), fixture.getPath('node_modules'), 'dir');
		await fs.symlink(path.resolve('.git'), fixture.getPath('.git'), 'dir');

		const gitPublishProcess = await gitPublish(fixture.path);

		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toMatch('✔');
	});
});
