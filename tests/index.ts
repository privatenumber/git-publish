import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit } from './utils/create-git.js';

const gitPublishPath = path.resolve('./dist/index.js');

// Remove node_modules/.bin from PATH added by pnpm
const PATH = process.env.PATH?.split(':').filter(p => !p.includes('node_modules/.bin')).join(':');

const gitPublish = (
	cwd: string,
) => execa(gitPublishPath, {
	cwd,
	reject: false,
	env: {
		PATH,
	},
});

describe('git-publish', ({ describe }) => {
	describe('Error cases', ({ test }) => {
		test('Fails if not in git repository', async () => {
			await using fixture = await createFixture();

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Not in a git repository');
		});

		test('Fails if no package.json found', async () => {
			await using fixture = await createFixture();

			await createGit(fixture.path);

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory');
		});

		test('Dirty working tree', async () => {
			await using fixture = await createFixture({
				'package.json': '{}',
			});

			const git = await createGit(fixture.path);
			await git('add', ['package.json']);

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Working tree is not clean');
		});
	});

	describe('Current project', async ({ test }) => {
		const fixture = await createFixture(process.cwd(), {
			templateFilter: cpPath => !(
				cpPath.endsWith(`${path.sep}node_modules`)
				|| path.basename(cpPath).startsWith('.')
				|| path.basename(cpPath) === 'dist'
			),
		});

		await fs.symlink(path.resolve('node_modules'), fixture.getPath('node_modules'), 'dir');

		console.log(fixture.path);
		const git = await createGit(fixture.path);
		await git('add', ['.']);
		await git('commit', ['-am', 'Initial commit']);

		await test('Errors on missing remote', async () => {
			const gitPublishProcess = await gitPublish(fixture.path);

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Git remote "origin" does not exist');
		});

		const { stdout: originRemote } = await execa('git', ['remote', 'get-url', 'origin']);
		await git('remote', ['add', 'origin', originRemote]);

		await test('Publishes', async ({ onTestFail }) => {
			const gitPublishProcess = await gitPublish(fixture.path);

			console.log(gitPublishProcess);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			expect(gitPublishProcess.exitCode).toBe(0);
			expect(gitPublishProcess.stdout).toMatch('✔');
		});
	});
});
