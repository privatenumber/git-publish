import fs from 'node:fs/promises';
import { describe, test, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Error cases', () => {
	test('Rejects invalid CLI input before publishing', async () => {
		await using markerFixture = await createFixture();
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
				scripts: {
					prepack: `node -e "require('node:fs').writeFileSync(process.argv[1], 'packed')" "${markerFixture.getPath('packed')}"`,
				},
			}),
		});

		const misspelledFlag = await gitPublish(fixture.path, ['--drry']);
		expect(('exitCode' in misspelledFlag) && misspelledFlag.exitCode).toBe(1);
		expect(misspelledFlag.stderr).toBe('Error: Unknown flag: --drry. (Did you mean --dry?)');

		const positionalArgument = await gitPublish(fixture.path, ['unexpected']);
		expect(('exitCode' in positionalArgument) && positionalArgument.exitCode).toBe(1);
		expect(positionalArgument.stderr).toBe('Error: This command does not accept positional arguments.');
		expect(await markerFixture.exists('packed')).toBe(false);
	});

	test('Missing default remote', async () => {
		await using markerFixture = await createFixture();
		await using fixture = await createGitFixture(async (fixture) => {
			await fixture.writeJson('package.json', {
				name: 'test-pkg',
				version: '1.0.0',
				scripts: {
					prepack: `node -e "require('node:fs').writeFileSync(process.argv[1], 'packed')" "${markerFixture.getPath('packed')}"`,
				},
			});

			const { git } = fixture;
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
		});

		const gitPublishProcess = await gitPublish(fixture.path);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toBe('Error: Git remote "origin" does not exist');
		expect(await markerFixture.exists('packed')).toBe(false);
	});

	test('Invalid publish branch', async () => {
		await using markerFixture = await createFixture();
		await using remoteFixture = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture(async (fixture) => {
			await fixture.writeJson('package.json', {
				name: 'test-pkg',
				version: '1.0.0',
				scripts: {
					prepack: `node -e "require('node:fs').writeFileSync(process.argv[1], 'packed')" "${markerFixture.getPath('packed')}"`,
				},
			});

			const { git } = fixture;
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);
		});

		const gitPublishProcess = await gitPublish(fixture.path, ['--branch', 'invalid..branch']);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toBe('Error: Invalid publish branch "invalid..branch".');
		expect(await markerFixture.exists('packed')).toBe(false);
	});

	test('Does not pack when remote is not a Git repository', async () => {
		await using markerFixture = await createFixture();
		await using remoteFixture = await createFixture();
		await using fixture = await createGitFixture(async (fixture) => {
			await fixture.writeJson('package.json', {
				name: 'test-pkg',
				version: '1.0.0',
				scripts: {
					prepack: `node -e "require('node:fs').writeFileSync(process.argv[1], 'packed')" "${markerFixture.getPath('packed')}"`,
				},
			});

			const { git } = fixture;
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);
		});

		const gitPublishProcess = await gitPublish(fixture.path);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(await markerFixture.exists('packed')).toBe(false);
	});

	test('Cleans up after pack worktree creation fails', async () => {
		await using hooksFixture = await createFixture(async (fixture) => {
			const packCheckoutPath = fixture.getPath('pack-checkout');
			const temporaryDirectoryModePath = fixture.getPath('temporary-directory-mode');
			const temporaryDirectoryPath = fixture.getPath('temporary-directory-path');
			await fixture.writeFile('post-checkout', `#!/bin/sh
stat -f '%Lp' "$PWD/.." > '${temporaryDirectoryModePath}' 2>/dev/null || stat -c '%a' "$PWD/.." > '${temporaryDirectoryModePath}'
printf '%s\n' "$PWD/.." > '${temporaryDirectoryPath}'
touch '${packCheckoutPath}'
exit 1
`);
			await fs.chmod(fixture.getPath('post-checkout'), 0o755);
		});
		await using remoteFixture = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture(async (fixture) => {
			await fixture.writeJson('package.json', {
				name: 'test-pkg',
				version: '1.0.0',
			});

			const { git } = fixture;
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
			await git('config', ['core.hooksPath', hooksFixture.path]);
			await git('remote', ['add', 'origin', remoteFixture.path]);
		});

		const { git } = fixture;

		try {
			const gitPublishProcess = await gitPublish(fixture.path);
			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(await hooksFixture.exists('pack-checkout')).toBe(true);
			expect(await hooksFixture.readFile('temporary-directory-mode', 'utf8')).toBe('700\n');
			const temporaryDirectory = await hooksFixture.readFile('temporary-directory-path', 'utf8');
			const temporaryDirectoryExists = await fs.access(temporaryDirectory.trim())
				.then(() => true, () => false);
			expect(temporaryDirectoryExists).toBe(false);

			// A failed creation must not leave temporary registrations behind.
			const worktrees = await git('worktree', ['list', '--porcelain']);
			expect(worktrees).not.toContain('git-publish-');
		} finally {
			// Remove leaked registrations when the regression fails.
			const worktrees = await git('worktree', ['list', '--porcelain']);
			const worktreePaths = worktrees.split('\n')
				.filter(worktree => worktree.startsWith('worktree ') && worktree.includes('/git-publish-'))
				.map(worktree => worktree.slice('worktree '.length));

			await Promise.all(worktreePaths.map(worktree => git('worktree', ['remove', '--force', worktree])));
		}
	});

	test('Does not create a workspace during dry runs', async () => {
		await using remoteFixture = await createGitFixture(undefined, ['--bare']);
		await using temporaryFixture = await createFixture();
		await using fixture = await createGitFixture(async (fixture) => {
			await fixture.writeJson('package.json', {
				name: 'test-pkg',
				version: '1.0.0',
			});

			const { git } = fixture;
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);
		});

		const gitPublishProcess = await gitPublish(fixture.path, ['--dry'], { TMPDIR: temporaryFixture.path });
		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(await temporaryFixture.readdir('')).toStrictEqual([]);
	});

	test('Workspace dependencies', async () => {
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
				dependencies: {
					'workspace-star': 'workspace:*',
					'workspace-range': 'workspace:^',
					'workspace-alias': 'workspace:workspace-target@*',
					'workspace-path': 'workspace:../workspace-target',
				},
				optionalDependencies: {
					'optional-workspace': 'workspace:~',
				},
				devDependencies: {
					'dev-workspace': 'workspace:*',
				},
			}, null, 2),
		});

		const { git } = fixture;
		await git('add', ['package.json']);
		await git('commit', ['-m', 'Initial commit']);

		const gitPublishProcess = await gitPublish(fixture.path);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toBe(`Error: Cannot publish packages with workspace dependencies:
- dependencies.workspace-star: workspace:*
- dependencies.workspace-range: workspace:^
- dependencies.workspace-alias: workspace:workspace-target@*
- dependencies.workspace-path: workspace:../workspace-target
- optionalDependencies.optional-workspace: workspace:~
Pre-bundle these dependencies before publishing.`);
	});

	test('Fails if not in git repository', async () => {
		await using fixture = await createFixture();

		const gitPublishProcess = await gitPublish(fixture.path);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toBe('Error: Not in a git repository.');
	});

	test('Fails if no package.json found', async () => {
		await using fixture = await createGitFixture();

		const gitPublishProcess = await gitPublish(fixture.path);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory.');
	});

	test('Dirty working tree', async () => {
		await using fixture = await createGitFixture({
			'package.json': '{}',
		});

		const { git } = fixture;
		await git('add', ['package.json']);

		const gitPublishProcess = await gitPublish(fixture.path);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toBe('Error: The working tree is not clean. Please commit or stash your changes before publishing.');
	});

	test('Private npm package', async () => {
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({ private: true }),
		});

		const { git } = fixture;

		await git('add', ['package.json']);
		await git('commit', ['-m', 'Initial commit']);

		const gitPublishProcess = await gitPublish(fixture.path);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toBe('Error: This package is marked as private. Use --force to publish it anyway.');
	});
});
