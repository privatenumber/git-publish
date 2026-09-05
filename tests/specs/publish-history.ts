import path from 'node:path';
import fs from 'node:fs/promises';
import spawn from 'nano-spawn';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit, createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Publish history', async () => {
	const remoteFixture = await createGitFixture(undefined, ['--bare']);
	onFinish(() => remoteFixture.rm());
	const { git: remoteGit } = remoteFixture;

	test('uses an exact tag from detached HEAD', async () => {
		const tagName = 'v1.2.3';
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
		});

		const { git } = fixture;
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
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
		});

		const { git } = fixture;
		await git('add', ['package.json']);
		await git('commit', ['-m', 'Initial commit']);
		const sourceCommit = await git('rev-parse', ['--short', 'HEAD']);
		await git('remote', ['add', 'origin', remoteFixture.path]);
		await git('checkout', ['--detach']);

		const gitPublishProcess = await gitPublish(fixture.path);

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(await remoteGit('rev-parse', [`npm/${sourceCommit}`])).toBeTruthy();
	});

	test('preserves standalone publication commit messages', async () => {
		const branchName = 'test-standalone-commit-message';
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
		await git('add', ['package.json']);
		await git('commit', ['-m', 'Initial commit']);
		const sourceCommit = await git('rev-parse', ['--short', 'HEAD']);
		await git('remote', ['add', 'origin', remoteFixture.path]);

		expect('exitCode' in await gitPublish(fixture.path)).toBe(false);
		expect(await remoteGit('show', ['--format=%s', '--no-patch', `npm/${branchName}`])).toBe(`Published from "${branchName}" (${sourceCommit})`);
	});

	test('prints one branch-based GitHub install command after standalone publication', async () => {
		const branchName = 'test-standalone-install-command';
		const githubUrl = 'https://github.com/test/repository.git';
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({ name: 'test-pkg', version: '1.0.0' }, null, 2),
		}, [`--initial-branch=${branchName}`]);
		await using configFixture = await createFixture();
		const { git } = fixture;
		await git('add', ['package.json']);
		await git('commit', ['-m', 'Initial commit']);
		const globalConfig = configFixture.getPath('gitconfig');
		await spawn('git', ['config', '--file', globalConfig, `url.file://${remoteFixture.path}.insteadOf`, githubUrl]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--remote', githubUrl], {
			GIT_CONFIG_GLOBAL: globalConfig,
			GIT_CONFIG_SYSTEM: configFixture.getPath('system-config'),
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toContain(`npm i 'test/repository#npm/${branchName}'`);
		expect(gitPublishProcess.stdout.split('→ Install command')).toHaveLength(2);
		expect(gitPublishProcess.stdout.indexOf('→ Install command')).toBeGreaterThan(
			gitPublishProcess.stdout.indexOf('Successfully published branch:'),
		);
	});

	test('preserves history', async () => {
		const branchName = 'test-preserve-history';

		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
			'index.js': 'console.log("v1");',
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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

	test('does not import destination tags', async () => {
		const branchName = 'test-destination-tags';
		const destinationTag = 'publish-history-tag';
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
			'index.js': 'export const version = 1;',
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
		await git('add', ['package.json', 'index.js']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);
		expect('exitCode' in await gitPublish(fixture.path, ['--fresh'])).toBe(false);
		await remoteGit('tag', ['--no-sign', destinationTag, `refs/heads/npm/${branchName}`]);

		await fixture.writeFile('index.js', 'export const version = 2;');
		await git('add', ['index.js']);
		await git('commit', ['-m', 'Update package']);
		expect('exitCode' in await gitPublish(fixture.path)).toBe(false);
		expect(await git('tag', ['--list', destinationTag])).toBe('');
	});

	test('fetches one publish commit without changing source metadata', async () => {
		const branchName = 'test-publish-fetch-metadata';
		const destinationTag = `publish-history-tag-${branchName}`;
		await using secondPushFixture = await createGitFixture(undefined, ['--bare']);
		await using commandsFixture = await createFixture(async (fixture) => {
			const headersPath = fixture.getPath('headers');
			await fixture.writeFile('upload-pack', `#!/bin/sh
	printf x >> '${fixture.getPath('upload-pack-called')}'
	exec git-upload-pack "$@"
	`);
			await fixture.writeFile('receive-pack', `#!/bin/sh
	printf x >> '${fixture.getPath('receive-pack-called')}'
	exec git-receive-pack "$@"
	`);
			await fixture.writeFile('post-commit', `#!/bin/sh
	git config --null --get-all http.extraHeader > '${headersPath}'
	`);
			await fixture.writeFile('system-config', '');
			await Promise.all([
				fs.chmod(fixture.getPath('upload-pack'), 0o755),
				fs.chmod(fixture.getPath('receive-pack'), 0o755),
				fs.chmod(fixture.getPath('post-commit'), 0o755),
			]);
		});
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
			'index.js': 'export const version = 1;',
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
		await git('add', ['package.json', 'index.js']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remoteFixture.path]);
		const remoteConfigPath = commandsFixture.getPath('remote-config');
		const globalConfigPath = commandsFixture.getPath('global-config');
		await git('config', ['--file', remoteConfigPath, 'remote.origin.uploadpack', commandsFixture.getPath('upload-pack')]);
		await git('config', ['--file', remoteConfigPath, 'remote.origin.receivepack', commandsFixture.getPath('receive-pack')]);
		await git('config', ['--file', remoteConfigPath, '--add', 'remote.origin.pushurl', remoteFixture.path]);
		await git('config', ['--file', remoteConfigPath, '--add', 'remote.origin.pushurl', secondPushFixture.path]);
		await git('config', ['--file', globalConfigPath, `includeIf.gitdir:${fixture.path}/.git.path`, remoteConfigPath]);
		await git('config', ['--file', globalConfigPath, '--add', 'http.extraHeader', 'X-Test: first']);
		await git('config', ['--file', globalConfigPath, '--add', 'http.extraHeader', 'X-Test: second']);
		await git('config', ['core.hooksPath', commandsFixture.path]);
		const environment = {
			GIT_CONFIG_SYSTEM: commandsFixture.getPath('system-config'),
			GIT_CONFIG_GLOBAL: globalConfigPath,
		};

		expect('exitCode' in await gitPublish(fixture.path, ['--fresh'], environment)).toBe(false);
		expect(await commandsFixture.readFile('headers', 'utf8')).toBe('X-Test: first\0X-Test: second\0');
		expect(await secondPushFixture.git('rev-parse', [`npm/${branchName}`])).toBeTruthy();
		await remoteGit('tag', ['--no-sign', destinationTag, `refs/heads/npm/${branchName}`]);
		await fixture.writeFile('index.js', 'export const version = 2;');
		await git('add', ['index.js']);
		await git('commit', ['-m', 'Update package']);
		const shallowPath = path.resolve(fixture.path, await git('rev-parse', ['--git-path', 'shallow']));
		const [sourceReferences, sourceTags, sourceWorktrees, sourceShallow] = await Promise.all([
			git('for-each-ref'),
			git('tag', ['--list']),
			git('worktree', ['list', '--porcelain']),
			fs.readFile(shallowPath, 'utf8').catch(() => ''),
		]);
		const tracePath = commandsFixture.getPath('trace');
		expect('exitCode' in await gitPublish(fixture.path, [], {
			...environment,
			GIT_TRACE_PACKET: tracePath,
		})).toBe(false);
		expect(await fs.readFile(tracePath, 'utf8')).toContain('deepen 1');
		expect(await commandsFixture.readFile('upload-pack-called', 'utf8')).toContain('x');
		expect(await commandsFixture.readFile('receive-pack-called', 'utf8')).toBe('xxxx');
		expect(await secondPushFixture.git('rev-parse', [`npm/${branchName}`])).toBeTruthy();
		const [nextReferences, nextTags, nextWorktrees, nextShallow] = await Promise.all([
			git('for-each-ref'),
			git('tag', ['--list']),
			git('worktree', ['list', '--porcelain']),
			fs.readFile(shallowPath, 'utf8').catch(() => ''),
		]);
		expect({
			references: nextReferences,
			tags: nextTags,
			worktrees: nextWorktrees,
			shallow: nextShallow,
		}).toStrictEqual({
			references: sourceReferences,
			tags: sourceTags,
			worktrees: sourceWorktrees,
			shallow: sourceShallow,
		});
	});

	test('preserves an already-shallow source repository', async () => {
		await using sourceRemoteFixture = await createGitFixture(undefined, ['--bare']);
		await using fullSourceFixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
			'index.js': 'export const version = 1;',
		}, ['--initial-branch=main']);
		const { git: sourceGit } = fullSourceFixture;
		await sourceGit('add', ['package.json', 'index.js']);
		await sourceGit('commit', ['-m', 'Initial commit']);
		await sourceGit('remote', ['add', 'origin', sourceRemoteFixture.path]);
		await sourceGit('push', ['origin', 'HEAD:main']);
		expect('exitCode' in await gitPublish(fullSourceFixture.path, ['--fresh'])).toBe(false);

		await using shallowSourceFixture = await createFixture();
		await spawn('git', ['clone', '--branch=main', '--depth=1', `file://${sourceRemoteFixture.path}`, shallowSourceFixture.path]);
		const shallowGit = createGit(shallowSourceFixture.path);
		await shallowGit('config', ['user.name', 'name']);
		await shallowGit('config', ['user.email', 'email']);
		const shallowFilePath = path.resolve(shallowSourceFixture.path, await shallowGit('rev-parse', ['--git-path', 'shallow']));
		const shallowFile = await fs.readFile(shallowFilePath, 'utf8');
		await shallowSourceFixture.writeFile('index.js', 'export const version = 2;');
		await shallowGit('add', ['index.js']);
		await shallowGit('commit', ['-m', 'Update package']);

		expect('exitCode' in await gitPublish(shallowSourceFixture.path)).toBe(false);
		expect(await fs.readFile(shallowFilePath, 'utf8')).toBe(shallowFile);
	});

	test('--fresh resets history', async () => {
		const branchName = 'test-fresh';

		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
			'index.js': 'console.log("v1");',
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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
});
