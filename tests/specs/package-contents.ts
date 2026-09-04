import path from 'node:path';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Package contents', async () => {
	const remoteFixture = await createFixture(async (fixture) => {
		await createGit(fixture.path).init(['--bare']);
	});
	onFinish(() => remoteFixture.rm());
	const remoteGit = createGit(remoteFixture.path);

	test('monorepo package', async () => {
		const branchName = 'test-monorepo';
		const packageName = '@org/test-pkg';

		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'monorepo-root',
				version: '1.0.0',
				private: true,
			}, null, 2),
			packages: {
				'test-pkg': {
					'package.json': JSON.stringify({
						name: packageName,
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
		await git.init([`--initial-branch=${branchName}`]);
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
		const publishedBranch = `npm/${branchName}-${packageName}`;
		const commitCount = await remoteGit('rev-list', ['--count', publishedBranch]);
		expect(Number(commitCount)).toBe(1);

		// Verify only dist files are published, not src
		const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
		const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
		expect(filesInTree).toEqual([
			'dist/index.js',
			'package.json',
		]);
	});

	test('publishes existing dist without build hooks', async () => {
		const branchName = 'test-existing-dist';

		// This test verifies that existing files are published even without build hooks
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-existing-dist',
				version: '1.0.0',
				files: ['dist'],
			}, null, 2),
			dist: {
				'index.js': 'export const existingFile = true;',
				'utils.js': 'export const util = () => {};',
			},
			src: {
				'source.ts': '// This should not be published',
			},
			'.gitignore': 'dist',
		});

		const git = createGit(fixture.path);
		await git.init([`--initial-branch=${branchName}`]);
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toMatch('✔');

		// Verify published files
		const publishedBranch = `npm/${branchName}`;
		const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
		const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
		expect(filesInTree).toEqual([
			'dist/index.js',
			'dist/utils.js',
			'package.json',
		]);

		// Verify content using git show (avoid checkout pollution)
		const indexContent = await remoteGit('show', [`${publishedBranch}:dist/index.js`]);
		expect(indexContent).toBe('export const existingFile = true;');

		const utilsContent = await remoteGit('show', [`${publishedBranch}:dist/utils.js`]);
		expect(utilsContent).toBe('export const util = () => {};');
	});

	test('publishes gitignored files specified by glob pattern', async () => {
		const branchName = 'test-glob-pattern';

		// Test that glob patterns in "files" field work correctly
		// Pattern "dist/*.js" should only match .js files in dist, not subdirectories
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-glob-pattern',
				version: '1.0.0',
				files: ['dist/*.js'],
			}, null, 2),
			dist: {
				'index.js': 'export const main = true;',
				'utils.js': 'export const util = () => {};',
				'types.ts': '// This should not be published',
				nested: {
					'deep.js': '// This should not be published (not matched by dist/*.js)',
				},
			},
			'.gitignore': 'dist',
		});

		const git = createGit(fixture.path);
		await git.init([`--initial-branch=${branchName}`]);
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toMatch('✔');

		// Verify only .js files in dist root are published
		const publishedBranch = `npm/${branchName}`;
		const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
		const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
		expect(filesInTree).toEqual([
			'dist/index.js',
			'dist/utils.js',
			'package.json',
		]);
	});

	test('publishes gitignored directory recursively', async () => {
		const branchName = 'test-directory-recursive';

		// Test that directory in "files" field includes all files recursively
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-directory-recursive',
				version: '1.0.0',
				files: ['dist'],
			}, null, 2),
			dist: {
				'index.js': 'export const main = true;',
				nested: {
					'deep.js': 'export const deep = true;',
					'utils.js': 'export const util = () => {};',
				},
			},
			'.gitignore': 'dist',
		});

		const git = createGit(fixture.path);
		await git.init([`--initial-branch=${branchName}`]);
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toMatch('✔');

		// Verify all files in dist are published recursively
		const publishedBranch = `npm/${branchName}`;
		const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
		const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
		expect(filesInTree).toEqual([
			'dist/index.js',
			'dist/nested/deep.js',
			'dist/nested/utils.js',
			'package.json',
		]);
	});

	test('publishes gitignored dotfiles', async () => {
		const branchName = 'test-dotfiles';

		// Test that dotfiles specified in "files" field are published
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-dotfiles',
				version: '1.0.0',
				files: ['.env.production', 'dist'],
			}, null, 2),
			'.env.production': 'PRODUCTION=true',
			dist: {
				'index.js': 'export const main = true;',
			},
			'.env.development': '// This should not be published',
			'.gitignore': 'dist\n.env.*',
		});

		const git = createGit(fixture.path);
		await git.init([`--initial-branch=${branchName}`]);
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toMatch('✔');

		// Verify dotfile and dist files are published
		const publishedBranch = `npm/${branchName}`;
		const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
		const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
		expect(filesInTree).toEqual([
			'.env.production',
			'dist/index.js',
			'package.json',
		]);

		// Verify dotfile content
		const dotfileContent = await remoteGit('show', [`${publishedBranch}:.env.production`]);
		expect(dotfileContent).toBe('PRODUCTION=true');
	});
});
