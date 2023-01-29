import path from 'path';
import { execa } from 'execa';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';

const gitPublish = path.resolve('./dist/index.js');

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

			await execa('git', ['init'], {
				cwd: fixture.path,
			});

			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory');

			await fixture.rm();
		});

		test('Dirty working tree', async () => {
			const fixture = await createFixture();

			await execa('git', ['init'], {
				cwd: fixture.path,
			});

			await fixture.writeFile('package.json', '{}');

			await execa('git', ['add', 'package.json'], {
				cwd: fixture.path,
			});

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
