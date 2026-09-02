import path from 'node:path';
import fs from 'node:fs/promises';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import yaml from 'js-yaml';
import { getGitHubRepositoryName } from '../src/utils/github.ts';
import { createGit } from './utils/create-git.ts';
import { gitPublish } from './utils/git-publish.ts';

describe('git-publish', () => {
	describe('GitHub remotes', () => {
		test('normalizes supported remote URLs', () => {
			for (const remoteUrl of [
				'git@github.com:owner/repository.git',
				'ssh://git@github.com/owner/repository.git',
				'https://github.com/owner/repository.git',
				'git+https://github.com/owner/repository.git',
				'git@github.com:owner/repository',
				'ssh://git@github.com/owner/repository',
				'https://github.com/owner/repository',
				'git+https://github.com/owner/repository',
			]) {
				expect(getGitHubRepositoryName(remoteUrl)).toBe('owner/repository');
			}
		});

		test('rejects non-repository URLs', () => {
			for (const remoteUrl of [
				'git@example.com:owner/repository.git',
				'https://github.com.example.com/owner/repository.git',
				'https://github.com/owner/repository/tree/main',
				'https://token@github.com/owner/repository.git',
				'https://github.com/owner/repository.git#main',
				'https://github.com/owner/repository.git?ref=main',
				'https://github.com/owner',
			]) {
				expect(getGitHubRepositoryName(remoteUrl)).toBeUndefined();
			}
		});
	});

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
			await using fixture = await createFixture(async (fixture) => {
				await fixture.writeJson('package.json', {
					name: 'test-pkg',
					version: '1.0.0',
					scripts: {
						prepack: `node -e "require('node:fs').writeFileSync(process.argv[1], 'packed')" "${markerFixture.getPath('packed')}"`,
					},
				});

				const git = createGit(fixture.path);
				await git.init();
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
			await using remoteFixture = await createFixture(async (fixture) => {
				await createGit(fixture.path).init(['--bare']);
			});
			await using fixture = await createFixture(async (fixture) => {
				await fixture.writeJson('package.json', {
					name: 'test-pkg',
					version: '1.0.0',
					scripts: {
						prepack: `node -e "require('node:fs').writeFileSync(process.argv[1], 'packed')" "${markerFixture.getPath('packed')}"`,
					},
				});

				const git = createGit(fixture.path);
				await git.init();
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
			await using fixture = await createFixture(async (fixture) => {
				await fixture.writeJson('package.json', {
					name: 'test-pkg',
					version: '1.0.0',
					scripts: {
						prepack: `node -e "require('node:fs').writeFileSync(process.argv[1], 'packed')" "${markerFixture.getPath('packed')}"`,
					},
				});

				const git = createGit(fixture.path);
				await git.init();
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
				const checkoutPath = fixture.getPath('checkout');
				await fixture.writeFile('post-checkout', `#!/bin/sh
touch '${checkoutPath}'
exit 1
`);
				await fs.chmod(fixture.getPath('post-checkout'), 0o755);
			});
			await using remoteFixture = await createFixture(async (fixture) => {
				await createGit(fixture.path).init(['--bare']);
			});
			await using fixture = await createFixture(async (fixture) => {
				await fixture.writeJson('package.json', {
					name: 'test-pkg',
					version: '1.0.0',
				});

				const git = createGit(fixture.path);
				await git.init();
				await git('add', ['package.json']);
				await git('commit', ['-m', 'Initial commit']);
				// Git runs this hook when creating the pack worktree.
				await git('config', ['core.hooksPath', hooksFixture.path]);
				await git('remote', ['add', 'origin', remoteFixture.path]);
			});

			const git = createGit(fixture.path);

			try {
				// The hook makes pack worktree creation fail.
				const gitPublishProcess = await gitPublish(fixture.path);
				expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
				expect(await hooksFixture.exists('checkout')).toBe(true);

				// A failed creation must not leave temporary registrations behind.
				const worktrees = await git('worktree', ['list', '--porcelain']);
				expect(worktrees).not.toContain('git-publish-');
			} finally {
				// Remove leaked registrations when the regression fails.
				const worktrees = await git('worktree', ['list', '--porcelain']);
				const worktreePaths = worktrees.split('\n')
					.filter(worktree => worktree.startsWith('worktree ') && worktree.includes('/git-publish/'))
					.map(worktree => worktree.slice('worktree '.length));

				await Promise.all(worktreePaths.map(worktree => git('worktree', ['remove', '--force', worktree])));
			}
		});

		test('Workspace dependencies', async () => {
			await using fixture = await createFixture({
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

			const git = createGit(fixture.path);
			await git.init();
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
			await using fixture = await createFixture(async (fixture) => {
				await createGit(fixture.path).init();
			});

			const gitPublishProcess = await gitPublish(fixture.path);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toBe('Error: No package.json found in current working directory.');
		});

		test('Dirty working tree', async () => {
			await using fixture = await createFixture(async (fixture) => {
				await createGit(fixture.path).init();

				return {
					'package.json': '{}',
				};
			});

			const git = createGit(fixture.path);
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

	describe('Publish', async () => {
		const remoteFixture = await createFixture(async (fixture) => {
			await createGit(fixture.path).init(['--bare']);
		});
		onFinish(() => remoteFixture.rm());
		const remoteGit = createGit(remoteFixture.path);

		test('raw Git destination', async () => {
			const branchName = 'test-raw-destination';
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
				'index.js': 'export const main = true;',
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
			await git('add', ['package.json', 'index.js']);
			await git('commit', ['-m', 'Initial commit']);

			const gitPublishProcess = await gitPublish(fixture.path, ['--remote', remoteFixture.path]);

			expect('exitCode' in gitPublishProcess).toBe(false);
			const files = await remoteGit('ls-tree', ['--name-only', `npm/${branchName}`]);
			expect(files.split('\n').sort()).toStrictEqual([
				'index.js',
				'package.json',
			]);
		});

		test('uses all configured push URLs', async () => {
			const branchName = 'test-push-url';
			await using firstPushFixture = await createFixture(async (fixture) => {
				await createGit(fixture.path).init(['--bare']);
			});
			await using secondPushFixture = await createFixture(async (fixture) => {
				await createGit(fixture.path).init(['--bare']);
			});
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);
			await git('remote', ['set-url', '--push', 'origin', firstPushFixture.path]);
			await git('remote', ['set-url', '--add', '--push', 'origin', secondPushFixture.path]);

			const gitPublishProcess = await gitPublish(fixture.path);
			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(await createGit(firstPushFixture.path)('rev-parse', [`npm/${branchName}`])).toBeTruthy();
			expect(await createGit(secondPushFixture.path)('rev-parse', [`npm/${branchName}`])).toBeTruthy();
			await expect(remoteGit('rev-parse', [`npm/${branchName}`])).rejects.toThrow();
		});

		test('uses an exact tag from detached HEAD', async () => {
			const tagName = 'v1.2.3';
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
			});

			const git = createGit(fixture.path);
			await git.init();
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
			await git('tag', ['--no-sign', tagName]);
			await git('remote', ['add', 'origin', remoteFixture.path]);
			await git('checkout', ['--detach']);

			const gitPublishProcess = await gitPublish(fixture.path);

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(await remoteGit('rev-parse', [`npm/${tagName}`])).toBeTruthy();
		});

		test('uses a short commit ID from untagged detached HEAD', async () => {
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
			});

			const git = createGit(fixture.path);
			await git.init();
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
			const sourceCommit = await git('rev-parse', ['--short', 'HEAD']);
			await git('remote', ['add', 'origin', remoteFixture.path]);
			await git('checkout', ['--detach']);

			const gitPublishProcess = await gitPublish(fixture.path);

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(await remoteGit('rev-parse', [`npm/${sourceCommit}`])).toBeTruthy();
		});

		test('preserves history', async () => {
			const branchName = 'test-preserve-history';

			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
				'index.js': 'console.log("v1");',
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
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
			const commitCount = await remoteGit('rev-list', ['--count', `npm/${branchName}`]);
			expect(Number(commitCount)).toBe(2);
		});

		test('does not make the source repository shallow or import tags when fetching publish history', async () => {
			const branchName = 'test-publish-fetch-metadata';
			const destinationTag = 'publish-history-tag';
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
				'index.js': 'export const version = 1;',
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
			await git('add', ['package.json', 'index.js']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const firstPublish = await gitPublish(fixture.path, ['--fresh']);
			expect('exitCode' in firstPublish).toBe(false);
			await remoteGit('tag', ['--no-sign', destinationTag, `refs/heads/npm/${branchName}`]);

			await fixture.writeFile('index.js', 'export const version = 2;');
			await git('add', ['index.js']);
			await git('commit', ['-m', 'Update package']);

			const nextPublish = await gitPublish(fixture.path);
			expect('exitCode' in nextPublish).toBe(false);
			const [isShallow, tags] = await Promise.all([
				git('rev-parse', ['--is-shallow-repository']),
				git('tag', ['--list', destinationTag]),
			]);
			expect({
				isShallow,
				tags,
			}).toStrictEqual({
				isShallow: 'false',
				tags: '',
			});
		});

		test('--fresh resets history', async () => {
			const branchName = 'test-fresh';

			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
				'index.js': 'console.log("v1");',
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
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
			const commitCount = await remoteGit('rev-list', ['--count', `npm/${branchName}`]);
			expect(Number(commitCount)).toBe(1);
		});

		test('cleans up temporary branches after orphan publishes', async () => {
			const branchName = 'test-orphan-branch-cleanup';
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
				}, null, 2),
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
			await git('add', ['package.json']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const firstPublish = await gitPublish(fixture.path);
			expect('exitCode' in firstPublish).toBe(false);
			expect(await git('branch', ['--list', 'git-publish-*'])).toBe('');

			const freshPublish = await gitPublish(fixture.path, ['--fresh']);
			expect('exitCode' in freshPublish).toBe(false);
			expect(await git('branch', ['--list', 'git-publish-*'])).toBe('');
		});

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

		test('npm pack is used', async () => {
			const branchName = 'test-npm-pack';

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

			// Verify files using git ls-tree (avoid checkout pollution)
			const publishedBranch = `npm/${branchName}`;
			const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
			const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();

			expect(filesInTree).toContain('prepare.txt');
			expect(filesInTree).toContain('prepack.txt');
			expect(filesInTree).toContain('dist/index.js');
			expect(filesInTree).not.toContain('src/excluded.ts'); // Should be excluded

			// Verify hook outputs using git show
			const prepareContent = await remoteGit('show', [`${publishedBranch}:prepare.txt`]);
			expect(prepareContent.trim()).toBe('prepare-ran');

			const prepackContent = await remoteGit('show', [`${publishedBranch}:prepack.txt`]);
			expect(prepackContent.trim()).toBe('prepack-ran');
		});

		test('installs published Git dependencies without build hooks', async () => {
			const branchName = 'test-git-install-hooks';
			const packageName = 'test-git-install-hooks';
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: packageName,
					version: '1.0.0',
					files: ['dist'],
					scripts: {
						prepare: 'node scripts/build.js',
						prepack: 'node scripts/build.js',
					},
				}, null, 2),
				scripts: {
					'build.js': "import fs from 'node:fs'; fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.js', 'export default true;');",
				},
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
			await git('add', ['package.json', 'scripts/build.js']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
			expect('exitCode' in gitPublishProcess).toBe(false);

			const publishedBranch = `npm/${branchName}`;
			const publishedPackageJson = JSON.parse(await remoteGit('show', [`${publishedBranch}:package.json`]));
			expect(publishedPackageJson.scripts?.prepare).toBeUndefined();
			expect(publishedPackageJson.scripts?.prepack).toBeUndefined();

			await using consumerFixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-git-consumer',
					private: true,
					dependencies: {
						[packageName]: `git+file://${remoteFixture.path}#${publishedBranch}`,
					},
				}, null, 2),
			});

			await spawn('pnpm', ['install'], { cwd: consumerFixture.path });
			expect(await consumerFixture.exists(`node_modules/${packageName}/dist/index.js`)).toBe(true);
		});

		test('dependencies are accessible in pack hooks', async () => {
			const branchName = 'test-deps-in-hooks';

			// This test verifies that dependencies with binaries are accessible during pack
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-deps-hooks',
					version: '1.0.0',
					scripts: {
						// Use clean-pkg-json binary from devDependencies
						prepack: 'clean-pkg-json',
					},
					devDependencies: {
						'clean-pkg-json': '^1.3.0',
					},
				}, null, 2),
			});

			// Install dependencies so clean-pkg-json binary is available
			await spawn('npm', ['install'], { cwd: fixture.path });

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			const gitPublishProcess = await gitPublish(fixture.path);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			// Checkout and verify clean-pkg-json ran and removed unnecessary fields
			const packageJsonString = await remoteGit('show', [`npm/${branchName}:package.json`]);
			const packageJson = JSON.parse(packageJsonString);

			// Verify required fields are still present
			expect(packageJson.name).toBe('test-deps-hooks');
			expect(packageJson.version).toBe('1.0.0');

			// Verify clean-pkg-json ran successfully
			expect(packageJson.devDependencies).toBeUndefined();
			expect(packageJson.scripts).toBeUndefined();
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

		test('prepack hook does not modify working directory', async () => {
			const branchName = 'test-prepack-isolation';

			// This test verifies that prepack hooks don't pollute the working directory
			// The hook creates a file, but it should only exist in the published branch
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-prepack-isolation',
					version: '1.0.0',
					scripts: {
						prepack: 'echo "hook-ran" > prepack-created-file.txt',
					},
				}, null, 2),
				'index.js': 'export const main = true;',
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			// Run git-publish
			const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(gitPublishProcess.stdout).toMatch('✔');

			// Verify working directory is still clean (no new files created)
			const statusOutput = await git('status', ['--porcelain']);
			expect(statusOutput).toBe('');

			// Verify the file created by prepack hook doesn't exist in working directory
			const fileExists = await fixture.exists('prepack-created-file.txt');
			expect(fileExists).toBe(false);

			// Verify the published branch has the file created by the hook
			const publishedBranch = `npm/${branchName}`;
			const publishedFileContent = await remoteGit('show', [`${publishedBranch}:prepack-created-file.txt`]);
			expect(publishedFileContent.trim()).toBe('hook-ran');
		});

		test('fails gracefully when pack hook dependencies are missing', async () => {
			const branchName = 'test-missing-deps';

			// Test that script doesn't crash on ENOENT when symlinking node_modules
			// Pack should fail gracefully with proper error message
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-missing-deps',
					version: '1.0.0',
					scripts: {
						prepack: 'nonexistent-binary',
					},
				}, null, 2),
				'index.js': 'export const main = true;',
			});

			const git = createGit(fixture.path);
			await git.init([`--initial-branch=${branchName}`]);
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			await git('remote', ['add', 'origin', remoteFixture.path]);

			// Do NOT run npm install - node_modules won't exist
			const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
			onTestFail(() => {
				console.log(gitPublishProcess);
			});

			// Should fail with exit code
			expect('exitCode' in gitPublishProcess).toBe(true);
			if ('exitCode' in gitPublishProcess) {
				expect(gitPublishProcess.exitCode).not.toBe(0);

				// Verify failure is from pack command (not from fs.symlink crash)
				// Exit code 127 means "command not found" - proves pack ran and failed
				// (If fs.symlink crashed, we wouldn't get this far)
				// Note: error goes to stdout (TTY) or stderr (non-TTY), so check combined output
				expect(gitPublishProcess.output).toMatch(/exit code 127/);
			}
		});

		test('surfaces the underlying reason when pack fails', async () => {
			const branchName = 'test-pack-error-output';
			const missingBinary = 'this-binary-does-not-exist-xyz';

			// When pack fails, the subprocess's stderr/stdout (the actual reason,
			// e.g. a failing prepack/build script) must be surfaced. Otherwise the
			// user only sees "Command failed with exit code N" with no way to debug.
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: 'test-pack-error-output',
					version: '1.0.0',
					scripts: {
						prepack: missingBinary,
					},
				}, null, 2),
				'index.js': 'export const main = true;',
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

			expect('exitCode' in gitPublishProcess).toBe(true);
			// The missing binary name only appears in the pack subprocess output,
			// never in nano-spawn's error.message. Asserting on it proves the
			// underlying reason was surfaced rather than swallowed.
			expect(gitPublishProcess.output).toMatch(missingBinary);

			// The failure is rendered inline within the task tree, so it must NOT
			// also be re-logged by the top-level error handler, which would print
			// "Error: Command failed with exit code N: …".
			expect(gitPublishProcess.output).not.toMatch('Error: Command failed');
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
});
