import path from 'node:path';
import spawn from 'nano-spawn';
import yaml from 'js-yaml';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Package managers', async () => {
	const remoteFixture = await createFixture(async (fixture) => {
		await createGit(fixture.path).init(['--bare']);
	});
	onFinish(() => remoteFixture.rm());
	const remoteGit = createGit(remoteFixture.path);

	describe('pnpm', () => {
		test('catalog protocol is resolved', async () => {
			const branchName = 'test-pnpm-catalog';
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
			await git.init([`--initial-branch=${branchName}`]);

			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
			onTestFail(() => {
				console.log('Git publish process:', gitPublishProcess);
			});
			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			const packageJsonString = await remoteGit('show', [`npm/${branchName}:package.json`]);
			const packageJson = JSON.parse(packageJsonString);
			expect(packageJson.dependencies.ms).toBe(msVersion);
		});

		test('monorepo workspace structure is accessible', async () => {
			const branchName = 'test-pnpm-monorepo';
			const packageName = '@org/monorepo-test';
			const msVersion = '2.1.3';

			await using fixture = await createFixture({
				'pnpm-workspace.yaml': yaml.dump({
					packages: ['packages/*'],
					catalog: {
						ms: msVersion,
					},
				}),
				'package.json': JSON.stringify({
					private: true,
				}, null, 2),
				'packages/test-pkg': {
					'package.json': JSON.stringify({
						name: packageName,
						version: '0.0.0',
						files: ['dist'],
						dependencies: {
							ms: 'catalog:',
						},
					}, null, 2),
				},
			});

			await spawn('pnpm', ['install'], { cwd: fixture.path });

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

			// Verify the package was published with catalog resolved
			const publishedBranch = `npm/${branchName}-${packageName}`;
			const packageJsonString = await remoteGit('show', [`${publishedBranch}:package.json`]);
			const packageJson = JSON.parse(packageJsonString);

			// Catalog should be resolved to actual version
			expect(packageJson.dependencies.ms).toBe(msVersion);
		});

		test('monorepo prepack hook can access root node_modules', async () => {
			const branchName = 'test-monorepo-root-deps';
			const packageName = '@org/root-deps-test';

			// Test that prepack hooks can access binaries from root node_modules
			await using fixture = await createFixture({
				'pnpm-workspace.yaml': yaml.dump({
					packages: ['packages/*'],
				}),
				'package.json': JSON.stringify({
					private: true,
					devDependencies: {
						'clean-pkg-json': '^1.0.0',
					},
				}, null, 2),
				'packages/test-pkg': {
					'package.json': JSON.stringify({
						name: packageName,
						version: '0.0.0',
						scripts: {
							prepack: 'clean-pkg-json',
						},
					}, null, 2),
					'index.js': 'export const main = true;',
				},
			});

			await spawn('pnpm', ['install'], { cwd: fixture.path });

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

			// Verify clean-pkg-json ran (scripts field should be removed)
			const publishedBranch = `npm/${branchName}-${packageName}`;
			const packageJsonString = await remoteGit('show', [`${publishedBranch}:package.json`]);
			const packageJson = JSON.parse(packageJsonString);
			expect(packageJson.scripts).toBeUndefined();
		});

		test('monorepo prepack hook can access package-level node_modules', async () => {
			const branchName = 'test-monorepo-pkg-deps';
			const packageName = '@org/pkg-deps-test';

			// Test that prepack hooks can access binaries from package-level node_modules
			await using fixture = await createFixture({
				'pnpm-workspace.yaml': yaml.dump({
					packages: ['packages/*'],
				}),
				'package.json': JSON.stringify({
					private: true,
				}, null, 2),
				'packages/test-pkg': {
					'package.json': JSON.stringify({
						name: packageName,
						version: '0.0.0',
						scripts: {
							prepack: 'mkdirp dist && echo "built" > dist/output.txt',
						},
						devDependencies: {
							mkdirp: '^3.0.0',
						},
						files: ['dist'],
					}, null, 2),
					'index.js': 'export const main = true;',
				},
			});

			await spawn('pnpm', ['install'], { cwd: fixture.path });

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

			// Verify mkdirp ran and created dist/output.txt
			const publishedBranch = `npm/${branchName}-${packageName}`;
			const outputContent = await remoteGit('show', [`${publishedBranch}:dist/output.txt`]);
			expect(outputContent.trim()).toBe('built');
		});
	});
});
