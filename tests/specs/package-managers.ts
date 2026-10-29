import path from 'node:path';
import fs from 'node:fs/promises';
import spawn from 'nano-spawn';
import yaml from 'js-yaml';
import { createFixture } from 'fs-fixture';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import { createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Package managers', async () => {
	const remoteFixture = await createGitFixture(undefined, ['--bare']);
	onFinish(() => remoteFixture.rm());
	const { git: remoteGit } = remoteFixture;

	describe('Install command', () => {
		for (const [packageManager, lockfile, command, packagePrefix] of [
			['npm', 'package-lock.json', 'npm i', ''],
			['pnpm', 'pnpm-lock.yaml', 'pnpm i', ''],
			['bun', 'bun.lock', 'bun i', ''],
			['yarn', 'yarn.lock', 'yarn add', '@org/test-pkg@'],
		] as const) {
			test(`prints the ${packageManager} install command`, async () => {
				const branchName = `test-${packageManager}-install-command`;
				const remoteUrl = 'https://github.com/owner/repository.git';
				await using fixture = await createGitFixture({
					'package.json': JSON.stringify({
						name: '@org/test-pkg',
						version: '1.0.0',
					}),
					[lockfile]: '',
				}, [`--initial-branch=${branchName}`]);

				// Pack with npm so these output tests do not require every package manager.
				await using commandsFixture = await createFixture();
				if (packageManager !== 'npm') {
					await commandsFixture.writeFile(packageManager, `#!/bin/sh
if [ "$1" = pm ]; then exec npm pack --pack-destination "$4"; fi
exec npm "$@"
`);
					await fs.chmod(commandsFixture.getPath(packageManager), 0o755);
				}

				const { git } = fixture;
				await git('add', ['package.json', lockfile]);
				await git('commit', ['-m', 'Initial commit']);
				await git('remote', ['add', 'origin', remoteUrl]);
				await git('config', ['remote.origin.pushurl', remoteFixture.path]);

				const result = await gitPublish(fixture.path, ['--fresh'], {
					PATH: `${commandsFixture.path}${path.delimiter}${process.env.PATH}`,
				});
				onTestFail(() => console.log(result));
				expect('exitCode' in result).toBe(false);
				expect(result.stdout).toContain(`${command} '${packagePrefix}${remoteUrl}#npm/${branchName}'`);
			});
		}
	});

	describe('pnpm', () => {
		test('catalog protocol is resolved', async () => {
			const branchName = 'test-pnpm-catalog';
			const msVersion = '2.1.3';

			await using fixture = await createGitFixture({
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
			}, [`--initial-branch=${branchName}`]);

			await spawn('pnpm', ['install'], { cwd: fixture.path });

			const { git } = fixture;

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

			await using fixture = await createGitFixture({
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
			}, [`--initial-branch=${branchName}`]);

			await spawn('pnpm', ['install'], { cwd: fixture.path });

			const { git } = fixture;
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
			await using fixture = await createGitFixture({
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
			}, [`--initial-branch=${branchName}`]);

			await spawn('pnpm', ['install'], { cwd: fixture.path });

			const { git } = fixture;
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
			await using fixture = await createGitFixture({
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
			}, [`--initial-branch=${branchName}`]);

			await spawn('pnpm', ['install'], { cwd: fixture.path });

			const { git } = fixture;
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
