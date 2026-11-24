import path from 'node:path';
import fs from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import spawn from 'nano-spawn';
import { createFixture } from 'fs-fixture';
import { createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';
import { testConcurrency } from '../utils/test-concurrency.ts';

type GitFixture = Awaited<ReturnType<typeof createGitFixture>>;

await describe('Package contents', async () => {
	const remoteFixture = await createGitFixture(undefined, ['--bare']);
	onFinish(() => remoteFixture.rm());
	const { git: remoteGit } = remoteFixture;

	test('detects pnpm from an ignored live lockfile', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'.gitignore': 'pnpm-lock.yaml\n',
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				scripts: { prepack: 'node -e "require(\u0027fs\u0027).writeFileSync(\u0027manager.txt\u0027,process.env.npm_config_user_agent)"' },
			}),
		}, ['--initial-branch=snapshot']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		await fixture.writeFile('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
		const result = await gitPublish(fixture.path);
		onTestFail(() => console.log(result.stdout, result.stderr));
		expect('exitCode' in result).toBe(false);
		expect(await remote.git('show', ['npm/snapshot:manager.txt'])).toMatch(/^pnpm\//);
	});

	for (const [description, manifest, extraFiles, file, gitExclude] of [
		['copies ignored mandatory main without files', { main: 'dist/index.js' }, { '.gitignore': 'dist/' }, 'dist/index.js'],
		['copies gitignored output with a root npmignore and no files', {}, {
			'.gitignore': 'dist/',
			'.npmignore': '',
		}, 'dist/index.js'],
		['copies untracked main outside files', {
			files: ['dist'],
			main: 'entry.js',
		}, {}, 'entry.js'],
		['copies a string bin outside files', {
			files: [],
			bin: './cli.js',
		}, {}, 'cli.js'],
		['copies an object bin outside files', {
			files: [],
			bin: { app: './cli.js' },
		}, {}, 'cli.js'],
		['copies directories.bin outside files', {
			files: [],
			directories: { bin: 'bin' },
		}, {}, 'bin/cli.js'],
		['copies nested files matched by a directory glob', { files: ['src/*'] }, {}, 'src/sub/x.js'],
		['copies files excluded by git info exclude', {}, {}, 'excluded.js', 'excluded.js\n'],
		['prefers nested npmignore over gitignore', {}, {
			'sub/.gitignore': 'index.js',
			'sub/.npmignore': '',
		}, 'sub/index.js'],
	] as const) {
		test(description, async () => {
			await using remote = await createGitFixture(undefined, ['--bare']);
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					...manifest,
				}),
				...extraFiles,
			}, ['--initial-branch=snapshot']);
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', remote.path]);
			if (gitExclude) {
				await fs.writeFile(fixture.getPath('.git/info/exclude'), gitExclude);
			}
			await fs.mkdir(path.dirname(fixture.getPath(file)), { recursive: true });
			await fixture.writeFile(file, 'untracked content');
			const result = await gitPublish(fixture.path);
			onTestFail(() => console.log(result.stdout, result.stderr));
			expect('exitCode' in result).toBe(false);
			expect(await remote.git('show', [`npm/snapshot:${file}`])).toBe('untracked content');
		});
	}

	test('publishes files inside an untracked nested repository', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				files: ['dist'],
			}),
		}, ['--initial-branch=snapshot']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		await fs.mkdir(fixture.getPath('dist/nested'), { recursive: true });
		await fixture.writeFile('dist/index.js', 'untracked content');
		await fixture.writeFile('dist/nested/index.js', 'nested repository content');
		await spawn('git', ['init', '-q'], { cwd: fixture.getPath('dist/nested') });
		const result = await gitPublish(fixture.path);
		onTestFail(() => console.log(result.stdout, result.stderr));
		expect('exitCode' in result).toBe(false);
		expect(await remote.git('ls-tree', ['-r', '--name-only', 'npm/snapshot'])).toBe('dist/index.js\ndist/nested/index.js\npackage.json');
	});

	test('publishes output ignored by a parent repository gitignore', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'.gitignore': 'dist/\n',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
		}, ['--initial-branch=snapshot']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		await fs.mkdir(fixture.getPath('packages/app/dist'));
		await fixture.writeFile('packages/app/dist/index.js', 'untracked content');
		const result = await gitPublish(fixture.getPath('packages/app'));
		onTestFail(() => console.log(result.output));
		expect('exitCode' in result).toBe(false);
		expect(await remote.git('show', ['npm/snapshot-app:dist/index.js'])).toBe('untracked content');
	});

	test('publishes untracked non-ignored files matched by files', async () => {
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				files: ['dist'],
			}),
		}, ['--initial-branch=untracked']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remoteFixture.path]);
		await fs.mkdir(fixture.getPath('dist'));
		await fixture.writeFile('dist/index.js', 'untracked content');
		const result = await gitPublish(fixture.path);
		onTestFail(() => console.log(result.stdout, result.stderr));
		expect('exitCode' in result).toBe(false);
		expect(await remoteGit('show', ['npm/untracked:dist/index.js'])).toBe('untracked content');
	});

	test('monorepo package', async () => {
		const branchName = 'test-monorepo';
		const packageName = '@org/test-pkg';

		await using fixture = await createGitFixture({
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
		}, [`--initial-branch=${branchName}`]);

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
		const outputLines = stripVTControlCharacters(gitPublishProcess.stdout).split('\n');
		const totalIndex = outputLines.findIndex(line => line.startsWith('Total size'));
		const fileRows = outputLines.slice(totalIndex - 2, totalIndex + 1);
		expect(fileRows.map(line => line.trim().split(/\s{2,}/)[0])).toStrictEqual([
			'dist/index.js',
			'package.json',
			'Total size',
		]);
		expect(new Set(fileRows.map(line => line.trimEnd().length)).size).toBe(1);

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
		await using fixture = await createGitFixture({
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
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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
		await using fixture = await createGitFixture({
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
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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
		await using fixture = await createGitFixture({
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
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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
		await using fixture = await createGitFixture({
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
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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

	test('warns when files field paths are missing from the packed package', async () => {
		const branchName = 'test-missing-files-field';

		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-missing-files-field',
				version: '1.0.0',
				files: ['dist', 'bin', 'index.js'],
			}, null, 2),
			'index.js': 'export default true;',
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(stripVTControlCharacters(gitPublishProcess.stdout)).toContain('package.json "files" lists paths that were not published: "dist", "bin"');

		const publishedBranch = `npm/${branchName}`;
		const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
		const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
		expect(filesInTree).toEqual([
			'index.js',
			'package.json',
		]);
	});

	test('does not warn when listed files are packed', async () => {
		const branchName = 'test-files-field-present';

		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-files-field-present',
				version: '1.0.0',
				files: ['dist', '!ignored.js'],
			}, null, 2),
			dist: {
				'index.js': 'export default true;',
			},
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(stripVTControlCharacters(gitPublishProcess.stdout)).not.toContain('were not published');
	});

	test('does not warn when files patterns match packed dotfiles', async () => {
		const branchName = 'test-files-field-dotfile-pattern';

		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-files-field-dotfile-pattern',
				version: '1.0.0',
				files: ['assets/*'],
			}, null, 2),
			assets: {
				'.hidden.json': '{}',
			},
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(stripVTControlCharacters(gitPublishProcess.stdout)).not.toContain('were not published');

		const publishedBranch = `npm/${branchName}`;
		const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
		expect(filesInTreeString.split('\n').filter(Boolean).sort()).toEqual([
			'assets/.hidden.json',
			'package.json',
		]);
	});

	test('does not warn when files patterns match packed paths', async () => {
		const branchName = 'test-files-field-patterns';

		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-files-field-patterns',
				version: '1.0.0',
				files: [
					'dist/**/*.js',
					'dist/*.{js,mjs}',
					'dist/[ab].js',
					'dist/@(a|b).js',
					'./dist',
				],
			}, null, 2),
			dist: {
				'a.js': 'export default true;',
			},
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(stripVTControlCharacters(gitPublishProcess.stdout)).not.toContain('were not published');
	});

	test('does not warn when prepack creates listed files', async () => {
		const branchName = 'test-files-field-prepack';

		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-files-field-prepack',
				version: '1.0.0',
				files: ['dist'],
				scripts: {
					prepack: 'mkdir dist && echo "built" > dist/index.js',
				},
			}, null, 2),
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--fresh']);
		onTestFail(() => {
			console.log(gitPublishProcess);
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(stripVTControlCharacters(gitPublishProcess.stdout)).not.toContain('were not published');

		const publishedBranch = `npm/${branchName}`;
		const filesInTreeString = await remoteGit('ls-tree', ['-r', '--name-only', publishedBranch]);
		const filesInTree = filesInTreeString.split('\n').filter(Boolean).sort();
		expect(filesInTree).toEqual([
			'dist/index.js',
			'package.json',
		]);
	});

	await describe('Version SHA', () => {
		const createVersionShaFixture = async (
			files: Parameters<typeof createGitFixture>[0],
			branch: string,
		) => {
			const remote = await createGitFixture(undefined, ['--bare']);
			const fixture = await createGitFixture(files, [`--initial-branch=${branch}`]);
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial']);
			await fixture.git('remote', ['add', 'origin', remote.path]);
			return {
				remote,
				fixture,
				readManifest: async (ref: string) => JSON.parse(await remote.git('show', [`${ref}:package.json`])),
				[Symbol.asyncDispose]: async () => {
					await fixture.rm();
					await remote.rm();
				},
			};
		};

		test('writes the version SHA before pack hooks run', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: 'node hook.cjs' },
				}),
				'hook.cjs': 'const p = require("./package.json"); require("fs").writeFileSync("seen.txt", `${process.env.npm_package_version} ${p.version} ${p.gitHead}`);',
			}, 'version-sha');
			const result = await gitPublish(setup.fixture.path, ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const commit = await setup.fixture.git('rev-parse', ['HEAD']);
			const shortCommit = await setup.fixture.git('rev-parse', ['--short', 'HEAD']);
			const manifest = await setup.readManifest('npm/version-sha');
			expect(manifest.version).toBe(`1.0.0+sha-${shortCommit}`);
			expect(manifest.gitHead).toBe(commit);
			expect(await setup.remote.git('show', ['npm/version-sha:seen.txt'])).toBe(`1.0.0+sha-${shortCommit} 1.0.0+sha-${shortCommit} ${commit}`);
		});

		test('leaves version and gitHead unchanged without --version-sha', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
				}),
			}, 'without-version-sha');
			const result = await gitPublish(setup.fixture.path);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			expect(await setup.readManifest('npm/without-version-sha')).toStrictEqual({
				name: 'app',
				version: '1.0.0',
			});
		});

		test('keeps the version SHA when pnpm pack drops build metadata', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
				}),
				'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
			}, 'version-sha-pnpm');
			const result = await gitPublish(setup.fixture.path, ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const shortCommit = await setup.fixture.git('rev-parse', ['--short', 'HEAD']);
			const { version } = await setup.readManifest('npm/version-sha-pnpm');
			expect(version).toBe(`1.0.0+sha-${shortCommit}`);
		});

		test('rejects a pnpm pack hook that changes the base version', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: 'node hook.cjs' },
				}),
				'hook.cjs': 'const fs = require("fs"); const p = require("./package.json"); p.version = "1.0.1"; fs.writeFileSync("package.json", JSON.stringify(p));',
				'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
			}, 'version-sha-pnpm-hook');
			const result = await gitPublish(setup.fixture.path, ['--version-sha']);
			expect('exitCode' in result).toBe(true);
			expect(result.output).toContain('has packed version "1.0.1", but --version-sha set "1.0.0+sha-');
			expect(await setup.remote.git('for-each-ref')).toBe('');
		});

		test('gives a versionless package 0.0.0 with the version SHA', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({ name: 'app' }),
			}, 'version-sha-versionless');
			const result = await gitPublish(setup.fixture.path, ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const shortCommit = await setup.fixture.git('rev-parse', ['--short', 'HEAD']);
			const { version } = await setup.readManifest('npm/version-sha-versionless');
			expect(version).toBe(`0.0.0+sha-${shortCommit}`);
		});

		test('reuses an unchanged publication with the version SHA of its own source commit', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					files: ['index.js'],
				}),
				'index.js': 'first',
			}, 'version-sha-reuse');
			const { fixture, remote } = setup;
			const expectVersionShaMatchesMessage = async () => {
				const manifest = await setup.readManifest('npm/version-sha-reuse');
				const message = await remote.git('log', ['-1', '--format=%s', 'npm/version-sha-reuse']);
				const shortCommit = /^Published from "version-sha-reuse" \(([\da-f]+)\)$/.exec(message)![1]!;
				expect(manifest.version).toBe(`1.0.0+sha-${shortCommit}`);
				expect(manifest.gitHead.startsWith(shortCommit)).toBe(true);
				return manifest;
			};
			expect('exitCode' in await gitPublish(fixture.path, ['--version-sha'])).toBe(false);
			const firstCommit = await fixture.git('rev-parse', ['HEAD']);
			const firstPublication = await remote.git('rev-parse', ['npm/version-sha-reuse']);

			await fixture.writeFile('notes.txt', 'not packed');
			await fixture.git('add', ['notes.txt']);
			await fixture.git('commit', ['-m', 'Unpacked change']);
			const reused = await gitPublish(fixture.path, ['--version-sha']);
			onTestFail(() => console.log(reused.output));
			expect('exitCode' in reused).toBe(false);
			expect(reused.output).toContain('Unchanged; reusing existing commit');
			expect(await remote.git('rev-parse', ['npm/version-sha-reuse'])).toBe(firstPublication);
			const reusedManifest = await expectVersionShaMatchesMessage();
			expect(reusedManifest.gitHead).toBe(firstCommit);

			await fixture.writeFile('index.js', 'second');
			await fixture.git('add', ['index.js']);
			await fixture.git('commit', ['-m', 'Packed change']);
			const changed = await gitPublish(fixture.path, ['--version-sha']);
			onTestFail(() => console.log(changed.output));
			expect('exitCode' in changed).toBe(false);
			expect(await remote.git('rev-parse', ['npm/version-sha-reuse^'])).toBe(firstPublication);
			const changedManifest = await expectVersionShaMatchesMessage();
			expect(changedManifest.gitHead).toBe(await fixture.git('rev-parse', ['HEAD']));
		});

		test('does not reuse a parent whose version SHA differs from its message', async () => {
			const foreignCommit = `abcdef1${'0'.repeat(33)}`;
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: 'node hook.cjs' },
				}),
				// Copies provenance from elsewhere, and leaves an existing version SHA alone
				'hook.cjs': `const fs = require("fs"); const p = require("./package.json"); if (!p.version.includes("+")) { p.version = "1.0.0+sha-abcdef1"; p.gitHead = "${foreignCommit}"; fs.writeFileSync("package.json", JSON.stringify(p)); }`,
			}, 'version-sha-foreign');
			const { fixture, remote } = setup;
			expect('exitCode' in await gitPublish(fixture.path)).toBe(false);
			const plainPublication = await remote.git('rev-parse', ['npm/version-sha-foreign']);
			const plain = await setup.readManifest('npm/version-sha-foreign');
			expect(plain.gitHead).toBe(foreignCommit);

			const result = await gitPublish(fixture.path, ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			expect(await remote.git('rev-parse', ['npm/version-sha-foreign^'])).toBe(plainPublication);
			const commit = await fixture.git('rev-parse', ['HEAD']);
			const shortCommit = await fixture.git('rev-parse', ['--short', 'HEAD']);
			const manifest = await setup.readManifest('npm/version-sha-foreign');
			expect(manifest.version).toBe(`1.0.0+sha-${shortCommit}`);
			expect(manifest.gitHead).toBe(commit);
		});

		for (const [description, forge] of [
			['an empty version SHA', async (clone: GitFixture) => {
				await clone.writeFile('package.json', JSON.stringify({
					name: 'app',
					version: '1.0.0+sha-',
					gitHead: '',
				}, null, 2));
			}],
			['a version SHA whose gitHead does not match', async (clone: GitFixture) => {
				const manifest = JSON.parse(await clone.readFile('package.json', 'utf8'));
				manifest.gitHead = '0'.repeat(40);
				await clone.writeFile('package.json', JSON.stringify(manifest, null, 2));
			}],
			['a null manifest', async (clone: GitFixture) => {
				await clone.writeFile('package.json', 'null');
			}],
			['a package.json mode change', async (clone: GitFixture) => {
				await fs.chmod(clone.getPath('package.json'), 0o755);
			}],
		] as const) {
			test(`does not reuse a parent with ${description}`, async () => {
				await using setup = await createVersionShaFixture({
					'package.json': JSON.stringify({
						name: 'app',
						version: '1.0.0',
					}),
				}, 'version-sha-forged');
				const { fixture, remote } = setup;
				expect('exitCode' in await gitPublish(fixture.path, ['--version-sha'])).toBe(false);
				const shortCommit = await fixture.git('rev-parse', ['--short', 'HEAD']);

				// Commit the forged parent with a message git-publish would write
				await using clone = await createGitFixture();
				await clone.git('fetch', [remote.path, 'npm/version-sha-forged']);
				await clone.git('checkout', ['-B', 'forged', 'FETCH_HEAD']);
				await forge(clone);
				await clone.git('add', ['package.json']);
				await clone.git('commit', ['-m', `Published from "version-sha-forged" (${shortCommit})`]);
				await clone.git('push', [remote.path, 'HEAD:npm/version-sha-forged']);
				const forged = await clone.git('rev-parse', ['HEAD']);

				const result = await gitPublish(fixture.path, ['--version-sha']);
				onTestFail(() => console.log(result.output));
				expect('exitCode' in result).toBe(false);
				expect(await remote.git('rev-parse', ['npm/version-sha-forged^'])).toBe(forged);
				const { version } = await setup.readManifest('npm/version-sha-forged');
				expect(version).toBe(`1.0.0+sha-${shortCommit}`);
			});
		}

		test('does not reuse an identical tree whose message names another commit', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
				}),
			}, 'version-sha-subject');
			const { fixture, remote } = setup;
			expect('exitCode' in await gitPublish(fixture.path, ['--version-sha'])).toBe(false);

			await using clone = await createGitFixture();
			await clone.git('fetch', [remote.path, 'npm/version-sha-subject']);
			await clone.git('checkout', ['-B', 'forged', 'FETCH_HEAD']);
			await clone.git('commit', ['--amend', '-m', 'Published from "version-sha-subject" (0000000)']);
			await clone.git('push', ['--force', remote.path, 'HEAD:npm/version-sha-subject']);
			const forged = await clone.git('rev-parse', ['HEAD']);

			const republished = await gitPublish(fixture.path, ['--version-sha']);
			onTestFail(() => console.log(republished.output));
			expect('exitCode' in republished).toBe(false);
			expect(await remote.git('rev-parse', ['npm/version-sha-subject^'])).toBe(forged);
			const replacement = await remote.git('rev-parse', ['npm/version-sha-subject']);

			const reused = await gitPublish(fixture.path, ['--version-sha']);
			onTestFail(() => console.log(reused.output));
			expect('exitCode' in reused).toBe(false);
			expect(await remote.git('rev-parse', ['npm/version-sha-subject'])).toBe(replacement);
		});

		test('does not mistake a file named "package.json " for package.json', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: 'node hook.cjs' },
				}),
				// Each pack writes different content, so only this file changes between runs
				'hook.cjs': 'require("fs").writeFileSync("package.json ", String(process.hrtime.bigint()));',
			}, 'version-sha-space');
			const { fixture, remote } = setup;
			expect('exitCode' in await gitPublish(fixture.path, ['--version-sha'])).toBe(false);
			const firstPublication = await remote.git('rev-parse', ['npm/version-sha-space']);
			const firstContent = await remote.git('show', ['npm/version-sha-space:package.json ']);

			const result = await gitPublish(fixture.path, ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			expect(await remote.git('rev-parse', ['npm/version-sha-space^'])).toBe(firstPublication);
			expect(await remote.git('show', ['npm/version-sha-space:package.json '])).not.toBe(firstContent);
		});

		test('reads the parent message regardless of log display settings', async () => {
			await using key = await createFixture();
			await spawn('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key.getPath('key')]);
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					files: ['index.js'],
				}),
				'index.js': '',
			}, 'version-sha-signed');
			const { fixture, remote } = setup;
			await fixture.git('config', ['gpg.format', 'ssh']);
			await fixture.git('config', ['user.signingkey', key.getPath('key.pub')]);
			await fixture.git('config', ['commit.gpgSign', 'true']);
			await fixture.git('config', ['log.showSignature', 'true']);
			await fixture.git('config', ['i18n.logOutputEncoding', 'UTF-16LE']);
			expect('exitCode' in await gitPublish(fixture.path, ['--version-sha'])).toBe(false);
			const firstPublication = await remote.git('rev-parse', ['npm/version-sha-signed']);

			await fixture.writeFile('notes.txt', 'not packed');
			await fixture.git('add', ['notes.txt']);
			await fixture.git('commit', ['--no-gpg-sign', '-m', 'Unpacked change']);
			const result = await gitPublish(fixture.path, ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			expect(await remote.git('rev-parse', ['npm/version-sha-signed'])).toBe(firstPublication);
			expect(await remote.git('cat-file', ['-p', firstPublication])).toMatch(/^gpgsig /m);
		});

		test('publishes a version bump as a new commit', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
				}),
			}, 'version-sha-bump');
			const { fixture, remote } = setup;
			expect('exitCode' in await gitPublish(fixture.path, ['--version-sha'])).toBe(false);
			const firstPublication = await remote.git('rev-parse', ['npm/version-sha-bump']);

			await fixture.writeFile('package.json', JSON.stringify({
				name: 'app',
				version: '1.0.1',
			}));
			await fixture.git('add', ['package.json']);
			await fixture.git('commit', ['-m', 'Bump version']);
			const result = await gitPublish(fixture.path, ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			expect(await remote.git('rev-parse', ['npm/version-sha-bump^'])).toBe(firstPublication);
			const shortCommit = await fixture.git('rev-parse', ['--short', 'HEAD']);
			const { version } = await setup.readManifest('npm/version-sha-bump');
			expect(version).toBe(`1.0.1+sha-${shortCommit}`);
		});

		test('adds the version SHA to a workspace dependency that a workspace:^ range still satisfies', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({ private: true }),
				'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
				'packages/app/package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					dependencies: { core: 'workspace:^' },
				}),
				'packages/core/package.json': JSON.stringify({
					name: 'core',
					version: '2.0.0',
				}),
			}, 'version-sha-workspace');
			const result = await gitPublish(setup.fixture.getPath('packages/app'), ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const shortCommit = await setup.fixture.git('rev-parse', ['--short', 'HEAD']);
			const coreCommit = await setup.remote.git('rev-parse', ['npm/version-sha-workspace-core']);
			const app = await setup.readManifest('npm/version-sha-workspace-app');
			expect(app.version).toBe(`1.0.0+sha-${shortCommit}`);
			expect(app.dependencies.core).toBe(`git+file://${setup.remote.path}#npm/version-sha-workspace-core`);
			const core = await setup.readManifest('npm/version-sha-workspace-core');
			expect(core.version).toBe(`2.0.0+sha-${shortCommit}`);

			// An unrelated source commit reuses both publications and keeps their version SHAs
			const appCommit = await setup.remote.git('rev-parse', ['npm/version-sha-workspace-app']);
			await setup.fixture.writeFile('notes.txt', 'not packed');
			await setup.fixture.git('add', ['notes.txt']);
			await setup.fixture.git('commit', ['-m', 'Unrelated change']);
			const republished = await gitPublish(setup.fixture.getPath('packages/app'), ['--version-sha']);
			onTestFail(() => console.log(republished.output));
			expect('exitCode' in republished).toBe(false);
			expect(await setup.remote.git('rev-parse', ['npm/version-sha-workspace-core'])).toBe(coreCommit);
			expect(await setup.remote.git('rev-parse', ['npm/version-sha-workspace-app'])).toBe(appCommit);
			expect(await setup.readManifest('npm/version-sha-workspace-app')).toStrictEqual(app);

			await setup.fixture.writeFile('packages/core/index.js', 'module.exports = 2;');
			await setup.fixture.git('add', ['packages/core/index.js']);
			await setup.fixture.git('commit', ['-m', 'Change core only']);
			const updated = await gitPublish(setup.fixture.getPath('packages/app'), ['--version-sha']);
			onTestFail(() => console.log(updated.output));
			expect('exitCode' in updated).toBe(false);
			const updatedShortCommit = await setup.fixture.git('rev-parse', ['--short', 'HEAD']);
			const updatedCore = await setup.readManifest('npm/version-sha-workspace-core');
			expect(updatedCore.version).toBe(`2.0.0+sha-${updatedShortCommit}`);
			expect(await setup.remote.git('rev-parse', ['npm/version-sha-workspace-app'])).toBe(appCommit);
			expect(await setup.readManifest('npm/version-sha-workspace-app')).toStrictEqual(app);
		});

		for (const [description, version, error] of [
			['build metadata', '1.0.0+build.1', 'Package "app" has version "1.0.0+build.1", which already has build metadata.'],
			['an unparseable version', '1.2', 'Package "app" has version "1.2", which is not valid semver.'],
			['a version with SHA over the length limit', `1.0.0-${'x'.repeat(240)}`, 'which is not valid semver. Versions can have at most 256 characters.'],
		]) {
			test(`rejects ${description}, including in a dry run`, async () => {
				await using setup = await createVersionShaFixture({
					'package.json': JSON.stringify({
						name: 'app',
						version,
					}),
				}, 'version-sha-invalid');
				for (const flags of [['--version-sha'], ['--dry', '--version-sha']]) {
					const result = await gitPublish(setup.fixture.path, flags);
					expect('exitCode' in result).toBe(true);
					expect(result.output).toContain(error);
				}
				expect(await setup.remote.git('for-each-ref')).toBe('');
			});
		}

		// npm keeps build metadata, so even the base version without the SHA is a change
		for (const packedVersion of ['1.0.1', '1.0.0']) {
			test(`rejects an npm pack hook that sets the version to ${packedVersion}`, async () => {
				await using setup = await createVersionShaFixture({
					'package.json': JSON.stringify({
						name: 'app',
						version: '1.0.0',
						scripts: { prepack: 'node hook.cjs' },
					}),
					'hook.cjs': `const fs = require("fs"); const p = require("./package.json"); p.version = "${packedVersion}"; fs.writeFileSync("package.json", JSON.stringify(p));`,
				}, 'version-sha-hook');
				const result = await gitPublish(setup.fixture.path, ['--version-sha']);
				expect('exitCode' in result).toBe(true);
				expect(result.output).toContain(`has packed version "${packedVersion}", but --version-sha set "1.0.0+sha-`);
				expect(result.output).toContain('A lifecycle script or the package manager\'s pack configuration changed the version.');
				expect(await setup.remote.git('for-each-ref')).toBe('');
			});
		}

		test('keeps dependency ranges that overlap peer ranges', async () => {
			await using setup = await createVersionShaFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					dependencies: { b: '^2.0.0' },
					peerDependencies: { b: '>=1.0.0' },
				}),
			}, 'version-sha-ranges');
			const result = await gitPublish(setup.fixture.path, ['--version-sha']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const manifest = await setup.readManifest('npm/version-sha-ranges');
			expect(manifest.dependencies).toStrictEqual({ b: '^2.0.0' });
			expect(manifest.peerDependencies).toStrictEqual({ b: '>=1.0.0' });
		});
	}, { parallel: testConcurrency });
}, { parallel: testConcurrency });
