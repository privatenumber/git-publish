import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit, gitWorktree } from './utils/create-git.js';
import { gitPublish } from './utils/git-publish.js';
import path from 'node:path';

describe('git-publish', ({ describe }) => {
	describe('Error cases', ({ test }) => {
		test('Fails if not in git repository', async () => {
			await using fixture = await createFixture();

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: Not in a git repository.');
		});

		test('Fails if no package.json found', async () => {
			await using fixture = await createFixture();

			const git = createGit(fixture.path);
			await git.init();

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory.');
		});

		test('Dirty working tree', async () => {
			await using fixture = await createFixture({
				'package.json': '{}',
			});

			const git = createGit(fixture.path);
			await git.init();

			await git('add', ['package.json']);

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: The working tree is not clean. Please commit or stash your changes before publishing.');
		});

		test('Private npm package', async () => {
			await using fixture = await createFixture({
				'package.json': JSON.stringify({ private: true }),
			});

			const git = createGit(fixture.path);
			await git.init();

			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: This package is marked as private. Use --force to publish it anyway.');
		});
	});

	describe('Publish', ({ test }) => {
		// test('preserves history', async ({ onTestFail }) => {
		// 	const preBranch = 'develop';

		// 	const git = createGit(process.cwd());
		// 	await git('fetch', ['origin', preBranch]);
		// 	await using worktree = await gitWorktree(process.cwd(), preBranch);

		// 	const gitPublishProcess = await gitPublish(worktree.path);
		// 	onTestFail(() => {
		// 		console.log(gitPublishProcess);
		// 	});

		// 	expect('exitCode' in gitPublishProcess).toBe(false);
		// 	expect(gitPublishProcess.stdout).toMatch('✔');

		// 	// The branch should remain unchanged
		// 	const afterBranch = await worktree.git('branch', ['--show-current']);
		// 	expect(afterBranch).toBe(preBranch);

		// 	// Assert that the published branch has multiple commits
		// 	const publishedBranch = `npm/${preBranch}`;
		// 	await worktree.git('fetch', ['--depth=2', 'origin', publishedBranch]);
		// 	const commitCount = await worktree.git('rev-list', ['--count', `origin/${publishedBranch}`]);
		// 	expect(Number(commitCount)).toBeGreaterThan(1);
		// });

		// test('--fresh', async ({ onTestFail }) => {
		// 	const preBranch = 'master';

		// 	const git = createGit(process.cwd());
		// 	await git('fetch', ['origin', preBranch]);
		// 	await using worktree = await gitWorktree(process.cwd(), preBranch);

		// 	const gitPublishProcess = await gitPublish(worktree.path, ['--fresh']);
		// 	onTestFail(() => {
		// 		console.log(gitPublishProcess);
		// 	});

		// 	expect('exitCode' in gitPublishProcess).toBe(false);
		// 	expect(gitPublishProcess.stdout).toMatch('✔');

		// 	// The branch should remain unchanged
		// 	const afterBranch = await worktree.git('branch', ['--show-current']);
		// 	expect(afterBranch).toBe(preBranch);

		// 	// Published branch should include the development commit
		// 	const publishedBranch = `npm/${preBranch}`;
		// 	await worktree.git('fetch', ['--depth=2', 'origin', publishedBranch]);
		// 	const commitCount = await worktree.git('rev-list', ['--count', `origin/${publishedBranch}`]);
		// 	expect(Number(commitCount)).toBe(1);
		// });

		test('monorepo package', async ({ onTestFail }) => {
			const preBranch = 'monorepo'; // change to develop later

			const git = createGit(process.cwd());
			await git('fetch', ['origin', preBranch]);
			await using worktree = await gitWorktree(process.cwd(), preBranch);

			const monorepoPackagePath = path.join(worktree.path, 'tests/monorepo-fixture');
			const gitPublishProcess = await gitPublish(monorepoPackagePath, ['--fresh']);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			// The branch should remain unchanged
			const afterBranch = await worktree.git('branch', ['--show-current']);
			expect(afterBranch).toBe(preBranch);

			// Published branch should include the development commit
			const publishedBranch = `npm/${preBranch}`;
			await worktree.git('fetch', ['--depth=2', 'origin', publishedBranch]);
			const commitCount = await worktree.git('rev-list', ['--count', `origin/${publishedBranch}`]);
			expect(Number(commitCount)).toBe(1);
		});
	});
});
