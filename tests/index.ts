import path from 'path';
import { execa } from 'execa';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';

const gitPublish = path.resolve('./dist/index.js');
const repoShorthandPattern = /^git@github\.com:(.+)\.git$/;

describe('git-publish', async ({ describe, test }) => {
	const { stdout: originUrl } = await execa('git', ['remote', 'get-url', 'origin']);
	const repoShorthand = originUrl.match(repoShorthandPattern)!;

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

			await execa('git', ['clone', originUrl, '.'], {
				cwd: fixture.path,
			});

			await fixture.writeFile('package.json', '{}');

			const gitPublishProcess = await execa(gitPublish, {
				cwd: fixture.path,
				reject: false,
			});

			expect(gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Working tree is not clean');

			await fixture.rm();
		});
	});

	test('Publishes', async () => {
		const fixture = await createFixture();

		await execa('git', ['clone', originUrl, '.'], {
			cwd: fixture.path,
		});

		const gitPublishProcess = await execa(gitPublish, {
			cwd: fixture.path,
			reject: false,
		});

		expect(gitPublishProcess.exitCode).toBe(0);
		expect(gitPublishProcess.stdout).toMatch(`npm i '${repoShorthand[1]}#npm/develop'`);

		await fixture.rm();
	});
});
