import spawn from 'nano-spawn';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Lifecycle hooks', async () => {
	const remoteFixture = await createFixture(async (fixture) => {
		await createGit(fixture.path).init(['--bare']);
	});
	onFinish(() => remoteFixture.rm());
	const remoteGit = createGit(remoteFixture.path);

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
		await spawn('pnpm', ['install'], { cwd: fixture.path });

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

		// Verify clean-pkg-json removed unnecessary fields
		const packageJsonString = await remoteGit('show', [`npm/${branchName}:package.json`]);
		const packageJson = JSON.parse(packageJsonString);

		// Verify required fields are still present
		expect(packageJson.name).toBe('test-deps-hooks');
		expect(packageJson.version).toBe('1.0.0');

		// Verify clean-pkg-json ran successfully
		expect(packageJson.devDependencies).toBeUndefined();
		expect(packageJson.scripts).toBeUndefined();
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

		// Do not install dependencies. node_modules must not exist.
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
});
