import fs from 'node:fs/promises';
import {
	describe, test, expect, onFinish,
} from 'manten';
import { createFixture } from 'fs-fixture';
import { createGit } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Remote transport', async () => {
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

	test('uses selected-remote configuration without applying origin settings', async () => {
		const branchName = 'test-selected-remote-configuration';
		await using commandsFixture = await createFixture(async (fixture) => {
			await fixture.writeFile('blocked-receive-pack', `#!/bin/sh
	touch '${fixture.getPath('blocked')}'
	exit 1
	`);
			await fs.chmod(fixture.getPath('blocked-receive-pack'), 0o755);
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
		await git('remote', ['add', 'publish', remoteFixture.path]);
		await git('config', ['remote.origin.receivepack', commandsFixture.getPath('blocked-receive-pack')]);

		for (const destination of ['publish', remoteFixture.path]) {
			expect('exitCode' in await gitPublish(fixture.path, [
				'--fresh',
				'--remote',
				destination,
			])).toBe(false);
		}

		expect(await commandsFixture.exists('blocked')).toBe(false);
		expect(await remoteGit('rev-parse', [`npm/${branchName}`])).toBeTruthy();
	});

	test('keeps SSH receive-pack commands unsanitized', async () => {
		const branchName = 'test-ssh-push-url';
		await using sshFixture = await createFixture(async (fixture) => {
			await fixture.writeFile('ssh', `#!/bin/sh
	shift
	case "$*" in
	"env "*) exit 1 ;;
	esac
	exec sh -c "$*"
	`);
			await fs.chmod(fixture.getPath('ssh'), 0o755);
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
		await git('config', ['core.sshCommand', sshFixture.getPath('ssh')]);
		await git('config', ['ssh.variant', 'simple']);
		await git('config', ['--add', 'remote.origin.pushurl', `git@example.test:${remoteFixture.path}`]);

		expect('exitCode' in await gitPublish(fixture.path, ['--fresh'])).toBe(false);
		expect(await remoteGit('rev-parse', [`npm/${branchName}`])).toBeTruthy();
	});

	test('sanitizes server commands for local push URLs', async () => {
		const branchName = 'test-local-push-url';
		await using commandsFixture = await createFixture(async (fixture) => {
			await fixture.writeFile('ssh', `#!/bin/sh
	shift
	exec sh -c "$*"
	`);
			await fixture.writeFile('receive-pack', `#!/bin/sh
	if [ -n "$GIT_CONFIG_SYSTEM$GIT_CONFIG_GLOBAL" ]; then
		exit 1
	fi
	exec git-receive-pack "$@"
	`);
			await fs.chmod(fixture.getPath('ssh'), 0o755);
			await fs.chmod(fixture.getPath('receive-pack'), 0o755);
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
		await git('remote', ['add', 'origin', `git@example.test:${remoteFixture.path}`]);
		await git('config', ['core.sshCommand', commandsFixture.getPath('ssh')]);
		await git('config', ['ssh.variant', 'simple']);
		await git('config', ['remote.origin.receivepack', commandsFixture.getPath('receive-pack')]);
		await git('config', ['--add', 'remote.origin.pushurl', remoteFixture.path]);

		expect('exitCode' in await gitPublish(fixture.path, ['--fresh'])).toBe(false);
		await fixture.writeFile('index.js', 'export const version = 2;');
		await git('add', ['index.js']);
		await git('commit', ['-m', 'Update package']);
		expect('exitCode' in await gitPublish(fixture.path)).toBe(false);
		expect(await remoteGit('rev-parse', [`npm/${branchName}`])).toBeTruthy();
	});

	test('preserves worktree transport configuration', async () => {
		const branchName = 'test-worktree-ssh-configuration';
		await using sshFixture = await createFixture(async (fixture) => {
			await fixture.writeFile('ssh', `#!/bin/sh
	shift
	exec sh -c "$*"
	`);
			await fs.chmod(fixture.getPath('ssh'), 0o755);
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
		await git('config', ['extensions.worktreeConfig', 'true']);
		await git('config', ['--worktree', 'core.sshCommand', sshFixture.getPath('ssh')]);
		await git('config', ['--worktree', 'ssh.variant', 'simple']);

		expect('exitCode' in await gitPublish(fixture.path, [
			'--fresh',
			'--remote',
			`git@example.test:${remoteFixture.path}`,
		])).toBe(false);
		expect(await remoteGit('rev-parse', [`npm/${branchName}`])).toBeTruthy();
	});
});
