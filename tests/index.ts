import path from 'path';
import { execa } from 'execa';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';

const gitPublish = path.resolve('./dist/index.js');

describe('Error cases', ({ test }) => {
	test('Fails if not in git repository', async () => {
		const fixture = await createFixture();

		const gitPublishProcess = await execa(gitPublish, {
			cwd: fixture.path,
			reject: false,
		});

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

		expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory');

		await fixture.rm();
	});
});
