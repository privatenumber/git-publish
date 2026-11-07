import fs from 'node:fs/promises';
import {
	describe, test, expect, onFinish,
} from 'manten';
import { createFixture } from 'fs-fixture';
import { getPublicationUrls } from '../../src/publish-repository/destination.ts';
import { getPublishRemote } from '../../src/publish-repository/remote.ts';
import { createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Remote transport', async () => {
	test('selects install and history URLs by destination identity', () => {
		expect(getPublicationUrls('git@host:repo.git', ['ssh://git@host/~/repo'], '/repo').historyUrl)
			.toBe('git@host:repo.git');
		expect(getPublicationUrls('git@host:repo.git', ['git@host:/repo.git'], '/repo').historyUrl)
			.toBe('git@host:/repo.git');
		expect(getPublicationUrls('a@host:repo.git', ['b@host:repo.git'], '/repo').historyUrl)
			.toBe('b@host:repo.git');
		expect(getPublicationUrls('https://GitHub.com/owner/repo.git', ['git@github.com:owner/repo'], '/repo'))
			.toStrictEqual({
				installUrl: 'https://GitHub.com/owner/repo.git',
				historyUrl: 'https://GitHub.com/owner/repo.git',
			});
		expect(getPublicationUrls('https://github.com/upstream/r.git', ['git@github.com:me/r.git'], '/repo'))
			.toStrictEqual({
				installUrl: 'https://github.com/me/r.git',
				historyUrl: 'git@github.com:me/r.git',
			});
		expect(getPublicationUrls('git@github.com:upstream/r.git', ['https://github.com/me/r'], '/repo'))
			.toStrictEqual({
				installUrl: 'git@github.com:me/r.git',
				historyUrl: 'https://github.com/me/r',
			});
		for (const host of ['gitlab.com', 'bitbucket.org']) {
			expect(getPublicationUrls(`ssh://git@${host}/upstream/r.git`, [`https://${host}/me/r.git`], '/repo'))
				.toStrictEqual({
					installUrl: `ssh://git@${host}/me/r.git`,
					historyUrl: `https://${host}/me/r.git`,
				});
		}
		expect(getPublicationUrls('ssh://git@example.test/a.git', ['ssh://git@example.test/b.git'], '/repo'))
			.toStrictEqual({
				installUrl: 'ssh://git@example.test/b.git',
				historyUrl: 'ssh://git@example.test/b.git',
			});
		expect(getPublicationUrls('./remote', ['/repo/remote'], '/repo'))
			.toStrictEqual({
				installUrl: './remote',
				historyUrl: './remote',
			});
		expect(getPublicationUrls('https://github.com/a/r', ['a', 'b'], '/repo'))
			.toStrictEqual({
				installUrl: 'https://github.com/a/r',
				historyUrl: 'https://github.com/a/r',
			});
	});

	test('honors pushInsteadOf when determining the push destination', async () => {
		await using fixture = await createGitFixture();
		await fixture.git('remote', ['add', 'origin', 'https://example.test/upstream/repo.git']);
		await fixture.git('config', ['url.https://example.test/fork/.pushInsteadOf', 'https://example.test/upstream/']);
		const remote = await getPublishRemote(fixture.path, 'origin', true);
		expect(remote.installUrl).toBe('https://example.test/fork/repo.git');
		expect(remote.historyUrl).toBe('https://example.test/fork/repo.git');
	});

	test('uses the first fetch URL and all configured URLs for pushes', async () => {
		await using fixture = await createGitFixture();
		await fixture.git('remote', ['add', 'origin', 'https://example.test/a.git']);
		await fixture.git('config', ['--add', 'remote.origin.url', 'https://example.test/b.git']);
		const remote = await getPublishRemote(fixture.path, 'origin', true);
		expect(remote.historyUrl).toBe('https://example.test/a.git');
		expect(remote.pushUrls).toStrictEqual(['https://example.test/a.git', 'https://example.test/b.git']);
	});

	test('loads standalone history from the push destination', async () => {
		await using upstream = await createGitFixture(undefined, ['--bare']);
		await using destination = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'standalone',
				version: '1.0.0',
			}),
		}, ['--initial-branch=triangular']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', upstream.path]);
		await fixture.git('config', ['remote.origin.pushurl', destination.path]);
		const first = await gitPublish(fixture.path);
		expect('exitCode' in first).toBe(false);
		expect(first.stdout).toContain(`git+file://${destination.path}#npm/triangular`);
		const commit = await destination.git('rev-parse', ['npm/triangular']);
		const second = await gitPublish(fixture.path);
		expect('exitCode' in second).toBe(false);
		expect(await destination.git('rev-parse', ['npm/triangular'])).toBe(commit);
		expect(await upstream.git('for-each-ref')).toBe('');
	});

	test('prints the fork with the fetch transport for a hosted triangular remote', async () => {
		await using upstream = await createGitFixture(undefined, ['--bare']);
		await using destination = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'standalone',
				version: '1.0.0',
			}),
		}, ['--initial-branch=hosted']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', 'https://github.com/upstream/repo.git']);
		await fixture.git('config', ['remote.origin.pushurl', 'git@github.com:fork/repo.git']);
		await fixture.git('config', [`url.${upstream.path}.insteadOf`, 'https://github.com/upstream/repo.git']);
		await fixture.git('config', [`url.${destination.path}.insteadOf`, 'git@github.com:fork/repo.git']);
		await using output = await createFixture();
		const result = await gitPublish(fixture.path, ['--json', output.getPath('result.json')]);
		expect('exitCode' in result).toBe(false);
		expect(result.stdout).toContain("npm i 'fork/repo#npm/hosted'");
		expect(await output.readFile('result.json', 'utf8')).toContain('git+https://github.com/fork/repo.git#');
		expect(await upstream.git('for-each-ref')).toBe('');
		expect(await destination.git('rev-parse', ['npm/hosted'])).toMatch(/^[0-9a-f]{40}$/);
	});

	const remoteFixture = await createGitFixture(undefined, ['--bare']);
	onFinish(() => remoteFixture.rm());
	const { git: remoteGit } = remoteFixture;

	test('raw Git destination', async () => {
		const branchName = 'test-raw-destination';
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
			'index.js': 'export const main = true;',
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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

	test('redacts credentials in dry-run remote output', async () => {
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}),
		}, ['--initial-branch=main']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		const result = await gitPublish(fixture.path, ['--dry', '--remote', 'https://user:secret@example.test/repo.git']);
		expect('exitCode' in result).toBe(false);
		expect(result.stdout).not.toContain('secret');
		expect(result.stderr).not.toContain('secret');
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
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}, null, 2),
		}, [`--initial-branch=${branchName}`]);

		const { git } = fixture;
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
