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
import { createYarnEnvironment } from '../utils/yarn-environment.ts';

describe('Package managers', async () => {
	const remoteFixture = await createGitFixture(undefined, ['--bare']);
	onFinish(() => remoteFixture.rm());
	const { git: remoteGit } = remoteFixture;

	describe('bun', () => {
		test('catalog protocol is resolved', async () => {
			const branchName = 'test-bun-catalog';
			const msVersion = '2.1.3';
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					private: true,
					workspaces: {
						packages: ['packages/*'],
						catalog: { ms: msVersion },
					},
				}),
				'.gitignore': 'node_modules',
				'packages/t/package.json': JSON.stringify({
					name: 't',
					version: '1.0.0',
					dependencies: { ms: 'catalog:' },
				}),
			}, [`--initial-branch=${branchName}`]);

			await spawn('bun', ['install'], { cwd: fixture.path });
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', remoteFixture.path]);

			const result = await gitPublish(fixture.getPath('packages/t'), ['--fresh']);
			onTestFail(() => console.log(result));
			expect('exitCode' in result).toBe(false);
			const packageJson = JSON.parse(await remoteGit('show', [`npm/${branchName}-t:package.json`]));
			expect(packageJson.dependencies.ms).toBe(msVersion);
		});

		test('pack hooks can access dependency binaries', async () => {
			const branchName = 'test-bun-pack-hook-dependency';
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'test-bun-pack-hook-dependency',
					version: '1.0.0',
					files: ['build-output.txt'],
					scripts: {
						prepack: 'fixture-build',
					},
					devDependencies: {
						'fixture-build': 'file:./fixture-build',
					},
				}, null, 2),
				'.gitignore': 'node_modules',
				'fixture-build': {
					'package.json': JSON.stringify({
						name: 'fixture-build',
						version: '1.0.0',
						bin: 'index.js',
					}, null, 2),
					'index.js': `#!/usr/bin/env node
require('node:fs').writeFileSync('build-output.txt', 'built');
`,
				},
			}, [`--initial-branch=${branchName}`]);

			await spawn('bun', ['install'], { cwd: fixture.path });
			const { git } = fixture;
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const gitPublishProcess = await gitPublish(fixture.path);
			onTestFail(() => console.log(gitPublishProcess));

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(await remoteGit('show', [`npm/${branchName}:build-output.txt`])).toBe('built');
		});
	});

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
				// Yarn's pack flags differ from npm's, so it uses the bundled Yarn binary.
				await using commandsFixture = await createFixture();
				let environment: Record<string, string> = {
					PATH: `${commandsFixture.path}${path.delimiter}${process.env.PATH}`,
				};
				if (packageManager === 'yarn') {
					environment = await createYarnEnvironment(commandsFixture, 'node_modules/yarn-berry/bin/yarn.js');
				} else if (packageManager !== 'npm') {
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
				await git('config', [`url.${remoteFixture.path}.insteadOf`, remoteUrl]);

				const result = await gitPublish(fixture.path, ['--fresh'], environment);
				onTestFail(() => console.log(result));
				expect('exitCode' in result).toBe(false);
				expect(result.stdout).toContain(`${command} '${packagePrefix}owner/repository#npm/${branchName}'`);
				expect(result.stdout.includes('npm 12+: add --allow-git=root')).toBe(packageManager === 'npm');
				expect(result.stdout.includes('approvedGitRepositories')).toBe(packageManager === 'yarn');
				expect(result.stdout).not.toContain('blockExoticSubdeps');
			});
		}
	});

	describe('Yarn', () => {
		test('rejects Yarn 1 before pushing', async () => {
			await using remote = await createGitFixture(undefined, ['--bare']);
			await using commands = await createFixture({
				yarn: '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.22.22; exit 0; fi\nexit 99\n',
			});
			await fs.chmod(commands.getPath('yarn'), 0o755);
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}),
				'yarn.lock': '',
			});
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', remote.path]);
			const result = await gitPublish(fixture.path, [], {
				PATH: `${commands.path}${path.delimiter}${process.env.PATH}`,
			});
			expect('exitCode' in result).toBe(true);
			expect(result.stdout + result.stderr).toContain('Yarn 1 is not supported. Use Yarn 4 or later');
			expect(await remote.git('branch', ['--list'])).toBe('');
		});

		test('catalog protocol is resolved', async () => {
			const branchName = 'test-yarn-catalog';
			const msVersion = '2.1.3';
			await using commandsFixture = await createFixture();
			const environment = await createYarnEnvironment(commandsFixture, 'node_modules/yarn-berry/bin/yarn.js');
			await using fixture = await createGitFixture({
				'.yarnrc.yml': yaml.dump({
					catalog: { ms: msVersion },
					nodeLinker: 'node-modules',
				}),
				'.gitignore': 'node_modules\n.yarn\n',
				'yarn.lock': '',
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
					dependencies: { ms: 'catalog:' },
				}),
			}, [`--initial-branch=${branchName}`]);

			await spawn('yarn', ['install'], {
				cwd: fixture.path,
				env: environment,
			});
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', remoteFixture.path]);

			const result = await gitPublish(fixture.path, ['--fresh'], environment);
			onTestFail(() => console.log(result));
			expect('exitCode' in result).toBe(false);
			const packageJson = JSON.parse(await remoteGit('show', [`npm/${branchName}:package.json`]));
			expect(packageJson.dependencies.ms).toBe(msVersion);
		});

		test('packs with Yarn 4', async () => {
			const branchName = 'test-yarn-4-pack';
			await using commandsFixture = await createFixture();
			const environment = await createYarnEnvironment(commandsFixture, 'node_modules/yarn-berry/bin/yarn.js', {
				isolatedCache: true,
			});

			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'test-yarn-pkg',
					version: '1.0.0',
					files: ['dist'],
					scripts: {
						prepack: 'node -e "fs.mkdirSync(\'dist\', { recursive: true }); fs.writeFileSync(\'dist/index.js\', \'built\')"',
					},
				}, null, 2),
				'yarn.lock': '',
				'.gitignore': 'dist',
			}, [`--initial-branch=${branchName}`]);
			await spawn('yarn', ['install'], {
				cwd: fixture.path,
				env: environment,
			});

			const { git } = fixture;
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const result = await gitPublish(fixture.path, ['--fresh'], environment);
			onTestFail(() => console.log(result));
			expect('exitCode' in result).toBe(false);

			const publishedBranch = `npm/${branchName}`;
			const files = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
			expect(files.split('\n')).toStrictEqual(['dist/index.js', 'package.json']);
			expect(await remoteGit('show', [`${publishedBranch}:dist/index.js`])).toBe('built');
		});
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
