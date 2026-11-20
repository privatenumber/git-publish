import path from 'node:path';
import fs from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import spawn from 'nano-spawn';
import { createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Package contents', async () => {
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

	describe('Commit stamp', () => {
		const createStampFixture = async (
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

		test('stamps version and gitHead before pack hooks run', async () => {
			await using stamp = await createStampFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: 'node hook.cjs' },
				}),
				'hook.cjs': 'require("fs").writeFileSync("seen.txt", `${process.env.npm_package_version} ${require("./package.json").version}`);',
			}, 'stamp');
			const result = await gitPublish(stamp.fixture.path, ['--stamp-commit']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const commit = await stamp.fixture.git('rev-parse', ['HEAD']);
			const shortCommit = await stamp.fixture.git('rev-parse', ['--short', 'HEAD']);
			const manifest = await stamp.readManifest('npm/stamp');
			expect(manifest.version).toBe(`1.0.0+sha-${shortCommit}`);
			expect(manifest.gitHead).toBe(commit);
			expect(await stamp.remote.git('show', ['npm/stamp:seen.txt'])).toBe(`1.0.0+sha-${shortCommit} 1.0.0+sha-${shortCommit}`);
		});

		test('leaves version and gitHead unchanged without --stamp-commit', async () => {
			await using stamp = await createStampFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
				}),
			}, 'unstamped');
			const result = await gitPublish(stamp.fixture.path);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			expect(await stamp.readManifest('npm/unstamped')).toStrictEqual({
				name: 'app',
				version: '1.0.0',
			});
		});

		test('keeps the stamp when pnpm pack drops build metadata', async () => {
			await using stamp = await createStampFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
				}),
				'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
			}, 'stamp-pnpm');
			const result = await gitPublish(stamp.fixture.path, ['--stamp-commit']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const shortCommit = await stamp.fixture.git('rev-parse', ['--short', 'HEAD']);
			const { version } = await stamp.readManifest('npm/stamp-pnpm');
			expect(version).toBe(`1.0.0+sha-${shortCommit}`);
		});

		test('stamps a versionless package as 0.0.0', async () => {
			await using stamp = await createStampFixture({
				'package.json': JSON.stringify({ name: 'app' }),
			}, 'stamp-versionless');
			const result = await gitPublish(stamp.fixture.path, ['--stamp-commit']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const shortCommit = await stamp.fixture.git('rev-parse', ['--short', 'HEAD']);
			const { version } = await stamp.readManifest('npm/stamp-versionless');
			expect(version).toBe(`0.0.0+sha-${shortCommit}`);
		});

		test('reuses an unchanged publication with the stamp of its own source commit', async () => {
			await using stamp = await createStampFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					files: ['index.js'],
				}),
				'index.js': 'first',
			}, 'stamp-reuse');
			const { fixture, remote } = stamp;
			const expectStampMatchesMessage = async () => {
				const manifest = await stamp.readManifest('npm/stamp-reuse');
				const message = await remote.git('log', ['-1', '--format=%s', 'npm/stamp-reuse']);
				const shortCommit = /^Published from "stamp-reuse" \(([\da-f]+)\)$/.exec(message)![1]!;
				expect(manifest.version).toBe(`1.0.0+sha-${shortCommit}`);
				expect(manifest.gitHead.startsWith(shortCommit)).toBe(true);
				return manifest;
			};
			expect('exitCode' in await gitPublish(fixture.path, ['--stamp-commit'])).toBe(false);
			const firstCommit = await fixture.git('rev-parse', ['HEAD']);
			const firstPublication = await remote.git('rev-parse', ['npm/stamp-reuse']);

			await fixture.writeFile('notes.txt', 'not packed');
			await fixture.git('add', ['notes.txt']);
			await fixture.git('commit', ['-m', 'Unpacked change']);
			const reused = await gitPublish(fixture.path, ['--stamp-commit']);
			onTestFail(() => console.log(reused.output));
			expect('exitCode' in reused).toBe(false);
			expect(reused.output).toContain('Unchanged; reusing existing commit');
			expect(await remote.git('rev-parse', ['npm/stamp-reuse'])).toBe(firstPublication);
			const reusedManifest = await expectStampMatchesMessage();
			expect(reusedManifest.gitHead).toBe(firstCommit);

			await fixture.writeFile('index.js', 'second');
			await fixture.git('add', ['index.js']);
			await fixture.git('commit', ['-m', 'Packed change']);
			const changed = await gitPublish(fixture.path, ['--stamp-commit']);
			onTestFail(() => console.log(changed.output));
			expect('exitCode' in changed).toBe(false);
			expect(await remote.git('rev-parse', ['npm/stamp-reuse^'])).toBe(firstPublication);
			const changedManifest = await expectStampMatchesMessage();
			expect(changedManifest.gitHead).toBe(await fixture.git('rev-parse', ['HEAD']));
		});

		test('stamps a workspace dependency that a workspace:^ range still satisfies', async () => {
			await using stamp = await createStampFixture({
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
			}, 'stamp-workspace');
			const result = await gitPublish(stamp.fixture.getPath('packages/app'), ['--stamp-commit']);
			onTestFail(() => console.log(result.output));
			expect('exitCode' in result).toBe(false);
			const shortCommit = await stamp.fixture.git('rev-parse', ['--short', 'HEAD']);
			const coreCommit = await stamp.remote.git('rev-parse', ['npm/stamp-workspace-core']);
			const app = await stamp.readManifest('npm/stamp-workspace-app');
			expect(app.version).toBe(`1.0.0+sha-${shortCommit}`);
			expect(app.dependencies.core).toBe(`git+file://${stamp.remote.path}#${coreCommit}`);
			const core = await stamp.readManifest('npm/stamp-workspace-core');
			expect(core.version).toBe(`2.0.0+sha-${shortCommit}`);
		});

		test('rejects a source version that already has build metadata, including in a dry run', async () => {
			await using stamp = await createStampFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0+build.1',
				}),
			}, 'stamp-build');
			for (const flags of [['--stamp-commit'], ['--dry', '--stamp-commit']]) {
				const result = await gitPublish(stamp.fixture.path, flags);
				expect('exitCode' in result).toBe(true);
				expect(result.output).toContain('Package "app" has version "1.0.0+build.1", which already has build metadata.');
			}
			expect(await stamp.remote.git('for-each-ref')).toBe('');
		});

		test('rejects a pack hook that changes the stamped version', async () => {
			await using stamp = await createStampFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: 'node hook.cjs' },
				}),
				'hook.cjs': 'const fs = require("fs"); const p = require("./package.json"); p.version = "1.0.1"; fs.writeFileSync("package.json", JSON.stringify(p));',
			}, 'stamp-hook');
			const result = await gitPublish(stamp.fixture.path, ['--stamp-commit']);
			expect('exitCode' in result).toBe(true);
			expect(result.output).toMatch(/has packed version "1\.0\.1", but --stamp-commit set "1\.0\.0\+sha-\w+"\. A pack hook changed the version\./);
			expect(await stamp.remote.git('for-each-ref')).toBe('');
		});
	});
});
