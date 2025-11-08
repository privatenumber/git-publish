import path from 'node:path';
import { describe, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import yaml from 'js-yaml';
import { createGit } from './utils/create-git.js';
import { gitPublish } from './utils/git-publish.js';

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

	describe('Publish', async ({ test, describe, onFinish }) => {
		const remoteFixture = await createFixture();
		const remoteGit = createGit(remoteFixture.path);
		await remoteGit.init(['--bare']);
		onFinish(() => remoteFixture.rm());

		test('preserves history', async ({ onTestFail }) => {
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
			const commitCount = await git('rev-list', ['--count', `origin/npm/${branchName}`]);
			expect(Number(commitCount)).toBe(2);
		});

		test('--fresh resets history', async ({ onTestFail }) => {
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
			const commitCount = await git('rev-list', ['--count', `origin/npm/${branchName}`]);
			expect(Number(commitCount)).toBe(1);
		});

		test('monorepo package', async ({ onTestFail }) => {
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

		describe('pnpm', ({ test }) => {
			test('catalog protocol is resolved', async ({ onTestFail }) => {
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

				await git('checkout', [`npm/${branchName}`]);

				const packageJsonString = await fixture.readFile('package.json', 'utf8');
				const packageJson = JSON.parse(packageJsonString);
				expect(packageJson.dependencies.ms).toBe(msVersion);
			});

			test('monorepo workspace structure is accessible', async ({ onTestFail }) => {
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
				const packageJsonString = await git('show', [`origin/${publishedBranch}:package.json`]);
				const packageJson = JSON.parse(packageJsonString);

				// Catalog should be resolved to actual version
				expect(packageJson.dependencies.ms).toBe(msVersion);
			});
		});

		test('npm pack is used', async ({ onTestFail }) => {
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
			const filesInTreeString = await git('ls-tree', ['-r', '--name-only', `origin/${publishedBranch}`]);
			const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();

			expect(filesInTree).toContain('prepare.txt');
			expect(filesInTree).toContain('prepack.txt');
			expect(filesInTree).toContain('dist/index.js');
			expect(filesInTree).not.toContain('src/excluded.ts'); // Should be excluded

			// Verify hook outputs using git show
			const prepareContent = await git('show', [`origin/${publishedBranch}:prepare.txt`]);
			expect(prepareContent.trim()).toBe('prepare-ran');

			const prepackContent = await git('show', [`origin/${publishedBranch}:prepack.txt`]);
			expect(prepackContent.trim()).toBe('prepack-ran');
		});

		test('dependencies are accessible in pack hooks', async ({ onTestFail }) => {
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
			await git('checkout', ['--force', `npm/${branchName}`]);

			const packageJsonString = await fixture.readFile('package.json', 'utf8');
			const packageJson = JSON.parse(packageJsonString);

			// Verify required fields are still present
			expect(packageJson.name).toBe('test-deps-hooks');
			expect(packageJson.version).toBe('1.0.0');

			// Verify clean-pkg-json ran successfully
			expect(packageJson.devDependencies).toBeUndefined();
			expect(packageJson.scripts).toBeUndefined();
		});

		test('publishes existing dist without build hooks', async ({ onTestFail }) => {
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
			const filesInTreeString = await git('ls-tree', ['-r', '--name-only', `origin/${publishedBranch}`]);
			const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
			expect(filesInTree).toEqual([
				'dist/index.js',
				'dist/utils.js',
				'package.json',
			]);

			// Verify content using git show (avoid checkout pollution)
			const indexContent = await git('show', [`origin/${publishedBranch}:dist/index.js`]);
			expect(indexContent).toBe('export const existingFile = true;');

			const utilsContent = await git('show', [`origin/${publishedBranch}:dist/utils.js`]);
			expect(utilsContent).toBe('export const util = () => {};');
		});

		test('prepack hook does not modify working directory', async ({ onTestFail }) => {
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
			const publishedFileContent = await git('show', [`origin/${publishedBranch}:prepack-created-file.txt`]);
			expect(publishedFileContent.trim()).toBe('hook-ran');
		});

		test('publishes gitignored files specified by glob pattern', async ({ onTestFail }) => {
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
			const filesInTreeString = await git('ls-tree', ['-r', '--name-only', `origin/${publishedBranch}`]);
			const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
			expect(filesInTree).toEqual([
				'dist/index.js',
				'dist/utils.js',
				'package.json',
			]);
		});

		test('publishes gitignored directory recursively', async ({ onTestFail }) => {
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
			const filesInTreeString = await git('ls-tree', ['-r', '--name-only', `origin/${publishedBranch}`]);
			const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
			expect(filesInTree).toEqual([
				'dist/index.js',
				'dist/nested/deep.js',
				'dist/nested/utils.js',
				'package.json',
			]);
		});

		test('publishes gitignored dotfiles', async ({ onTestFail }) => {
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
			const filesInTreeString = await git('ls-tree', ['-r', '--name-only', `origin/${publishedBranch}`]);
			const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
			expect(filesInTree).toEqual([
				'.env.production',
				'dist/index.js',
				'package.json',
			]);

			// Verify dotfile content
			const dotfileContent = await git('show', [`origin/${publishedBranch}:.env.production`]);
			expect(dotfileContent).toBe('PRODUCTION=true');
		});
	});
});
