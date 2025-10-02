import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import yaml from 'js-yaml';
import { createGit, gitWorktree } from './utils/create-git.js';
import { gitPublish } from './utils/git-publish.js';

const readJson = async (filePath: string) => {
	const content = await fs.readFile(filePath, 'utf8');
	return JSON.parse(content);
};

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

	describe('Publish', async ({ test, onFinish }) => {
		const remoteFixture = await createFixture();
		const remoteGit = createGit(remoteFixture.path);
		await remoteGit.init(['--bare']);
		onFinish(() => remoteFixture.rm());

		test('preserves history', async ({ onTestFail }) => {
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
				'index.js': 'console.log("v1");',
			});

			const git = createGit(fixture.path);
			await git.init();
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			// First publish
			const firstPublish = await gitPublish(fixture.path, ['--fresh']);
			if ('exitCode' in firstPublish) {
				throw new Error(`First publish failed: ${firstPublish.stderr}`);
			}

			// Make a change and commit
			await fixture.writeFile('index.js', 'console.log("v2");');
			await git('add', ['.']);
			await git('commit', ['-m', 'Second commit']);

			// Second publish (should preserve history)
			const gitPublishProcess = await gitPublish(fixture.path);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			// Assert that the published branch has 2 commits
			const publishedBranch = 'npm/master';
			const commitCount = await git('rev-list', ['--count', `origin/${publishedBranch}`]);
			expect(Number(commitCount)).toBe(2);
		});

		test('--fresh resets history', async ({ onTestFail }) => {
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
				'index.js': 'console.log("v1");',
			});

			const git = createGit(fixture.path);
			await git.init();
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			// First publish
			const firstPublish = await gitPublish(fixture.path, ['--fresh']);
			if ('exitCode' in firstPublish) {
				throw new Error(`First publish failed: ${firstPublish.stderr}`);
			}

			// Make a change and commit
			await fixture.writeFile('index.js', 'console.log("v2");');
			await git('add', ['.']);
			await git('commit', ['-m', 'Second commit']);

			// Second publish with --fresh (should reset history to 1 commit)
			const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			// Published branch should have exactly 1 commit (fresh start)
			const publishedBranch = 'npm/master';
			const commitCount = await git('rev-list', ['--count', `origin/${publishedBranch}`]);
			expect(Number(commitCount)).toBe(1);
		});

		test('monorepo package', async ({ onTestFail }) => {
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'monorepo-root',
					version: '1.0.0',
					private: true,
				}, null, 2),
				packages: {
					'test-pkg': {
						'package.json': JSON.stringify({
							name: '@org/test-pkg',
							version: '0.0.0',
							files: ['dist'],
						}, null, 2),
						dist: {
							'index.js': 'console.log("hello world");',
						},
						src: {
							'excluded.ts': '// This should not be published',
						},
					},
				},
			});

			const git = createGit(fixture.path);
			await git.init();
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const monorepoPackagePath = path.join(fixture.path, 'packages/test-pkg');
			const gitPublishProcess = await gitPublish(monorepoPackagePath, ['--fresh']);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			// Published branch should have exactly 1 commit
			const publishedBranch = 'npm/master-@org/test-pkg';
			const commitCount = await git('rev-list', ['--count', `origin/${publishedBranch}`]);
			expect(Number(commitCount)).toBe(1);

			// Verify only dist files are published, not src
			const filesInTreeString = await git('ls-tree', ['-r', '--name-only', `origin/${publishedBranch}`]);
			const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
			expect(filesInTree).toEqual([
				'dist/index.js',
				'package.json',
			]);
		});

		test('pnpm catalog protocol is resolved', async ({ onTestFail }) => {
			const msVersion = '2.1.3';
			await using fixture = await createFixture({
				'pnpm-workspace.yaml': yaml.dump({
					catalog: {
						ms: msVersion,
					},
				}),
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
					dependencies: {
						ms: 'catalog:',
					},
				}, null, 2),
			});

			await spawn('pnpm', ['install'], { cwd: fixture.path });

			const git = createGit(fixture.path);
			await git.init();

			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
			onTestFail(() => {
				console.log('Git publish process:', gitPublishProcess);
			});
			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			await git('checkout', ['npm/master']);

			const packageJsonString = await fixture.readFile('package.json', 'utf8');
			const packageJson = JSON.parse(packageJsonString);
			expect(packageJson.dependencies.ms).toBe(msVersion);
		});

		test('npm pack is used', async ({ onTestFail }) => {
			// This test verifies that npm pack is used (with lifecycle hooks)
			// by creating a package with prepare/prepack scripts that generate files
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-npm-pack',
					version: '1.0.0',
					files: ['dist', '*.txt'],
					scripts: {
						prepare: 'echo "prepare-ran" > prepare.txt',
						prepack: 'echo "prepack-ran" > prepack.txt',
					},
				}),
				dist: {
					'index.js': 'export const main = true;',
				},
				src: {
					'excluded.ts': '// This should not be in the pack',
				},
			});

			const git = createGit(fixture.path);
			await git.init();
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			// Clone the published branch to verify
			await using publishedClone = await createFixture();
			const publishedGit = createGit(publishedClone.path);
			await publishedGit('clone', ['--branch', 'npm/master', remoteFixture.path, publishedClone.path]);

			// Check that lifecycle hooks ran and created files
			const files = await fs.readdir(publishedClone.path);
			expect(files).toContain('prepare.txt');
			expect(files).toContain('prepack.txt');
			expect(files).toContain('dist');
			expect(files).not.toContain('src'); // Should be excluded

			// Verify hook outputs
			const prepareContent = await fs.readFile(path.join(publishedClone.path, 'prepare.txt'), 'utf8');
			const prepackContent = await fs.readFile(path.join(publishedClone.path, 'prepack.txt'), 'utf8');
			expect(prepareContent.trim()).toBe('prepare-ran');
			expect(prepackContent.trim()).toBe('prepack-ran');
		});
	});
});
