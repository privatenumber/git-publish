import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
	describe, test, expect, onFinish,
} from 'manten';
import { createFixture } from 'fs-fixture';
import { getPublicationUrls } from '../../src/publish-repository/destination.ts';
import { getPublishRemote } from '../../src/publish-repository/remote.ts';
import { createGit, createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Remote transport', async () => {
	test('rejects an empty --remote before packing', async () => {
		await using marker = await createFixture();
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				scripts: { prepack: `node -e "require('node:fs').writeFileSync('${marker.getPath('packed')}', '')"` },
			}),
		});
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('branch', ['npm/safe']);
		const sourceReferences = await fixture.git('for-each-ref');
		for (const remoteArgument of ['--remote=', '--remote']) {
			const result = await gitPublish(fixture.path, ['--fresh', '--branch', 'npm/safe', remoteArgument]);
			expect(('exitCode' in result) && result.exitCode).toBe(1);
			expect(result.output).toContain('--remote requires a remote name or Git URL.');
			expect(await marker.exists('packed')).toBe(false);
			expect(await fixture.git('for-each-ref')).toBe(sourceReferences);
		}
	});

	test('publishes to the selected remote despite inherited configuration for a remote named publish', async () => {
		await using destination = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
		});
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('branch', ['published']);
		await fixture.git('remote', ['add', 'origin', destination.path]);
		const sourceReferences = await fixture.git('for-each-ref');
		const result = await gitPublish(fixture.path, ['--fresh', '--branch', 'published'], {
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'remote.publish.url',
			GIT_CONFIG_VALUE_0: fixture.path,
		});
		expect('exitCode' in result).toBe(false);
		expect(await destination.git('rev-parse', ['refs/heads/published'])).toMatch(/^[0-9a-f]{40}$/);
		expect(result.output).not.toMatch(/git-publish-[0-9a-f]{8}-[0-9a-f-]{27}/i);
		expect(await fixture.git('for-each-ref')).toBe(sourceReferences);
	});

	test('ignores pushInsteadOf for an explicit pushurl', async () => {
		await using fetchRemote = await createGitFixture(undefined, ['--bare']);
		await using pushRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
		}, ['--initial-branch=source']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('branch', ['npm/source']);
		const sourceReferences = await fixture.git('for-each-ref');
		await fixture.git('remote', ['add', 'origin', fetchRemote.path]);
		await fixture.git('config', ['remote.origin.pushurl', pushRemote.path]);
		await fixture.git('config', [`url.${fixture.path}.pushInsteadOf`, pushRemote.path]);
		expect(await fixture.git('remote', ['get-url', '--push', 'origin'])).toBe(pushRemote.path);
		const result = await gitPublish(fixture.path, ['--fresh']);
		expect('exitCode' in result).toBe(false);
		expect(await pushRemote.git('rev-parse', ['npm/source'])).toMatch(/^[0-9a-f]{40}$/);
		expect(await fetchRemote.git('for-each-ref')).toBe('');
		expect(await fixture.git('for-each-ref')).toBe(sourceReferences);
	});

	test('refuses an effective push destination in the source repository', async () => {
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
		}, ['--initial-branch=source']);
		await using aliases = await createFixture();
		const gitDirectoryAlias = aliases.getPath('source git dir');
		await fs.symlink(fixture.getPath('.git'), gitDirectoryAlias, 'junction');
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('branch', ['npm/source']);
		const sourceReferences = await fixture.git('for-each-ref');
		const remoteUrl = 'https://example.test/source';
		await fixture.git('remote', ['add', 'origin', remoteUrl]);
		for (const destination of [fixture.path, pathToFileURL(gitDirectoryAlias).href]) {
			await fixture.git('config', [`url.${destination}.insteadOf`, remoteUrl]);
			const result = await gitPublish(fixture.path, ['--fresh']);
			expect(('exitCode' in result) && result.exitCode).toBe(1);
			expect(result.output).toContain('Refusing to push to the source repository.');
			expect(result.output).not.toContain(destination);
			expect(result.output).not.toContain(remoteUrl);
			expect(await fixture.git('for-each-ref')).toBe(sourceReferences);
			await fixture.git('config', ['--unset', `url.${destination}.insteadOf`]);
		}
	});

	test('refuses a file push URL with an encoded newline in its authority', async () => {
		await using fixture = await createGitFixture({
			'package.json': '{"name":"app","version":"1.0.0"}',
		}, ['--initial-branch=source']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('branch', ['npm/source']);
		const references = await fixture.git('for-each-ref');
		const remoteUrl = 'https://example.test/source';
		await fixture.git('remote', ['add', 'origin', remoteUrl]);
		const url = pathToFileURL(fixture.path).href.replace('file://', 'file://h%0ADiag%3A%20path%3Dmissing');
		await fixture.git('config', [`url.${url}.insteadOf`, remoteUrl]);
		const result = await gitPublish(fixture.path, ['--fresh']);
		expect(('exitCode' in result) && result.exitCode).toBe(1);
		expect(result.output).toContain('Could not verify the Git push destination.');
		expect(await fixture.git('for-each-ref')).toBe(references);
	});

	test('refuses to push from a linked worktree to the same repository', async () => {
		await using source = await createGitFixture({
			'package.json': '{"name":"app","version":"1.0.0"}',
		});
		await using checkouts = await createFixture();
		await source.git('add', ['.']);
		await source.git('commit', ['-m', 'initial']);
		const linked = checkouts.getPath('linked');
		const sibling = checkouts.getPath('sibling');
		await source.git('worktree', ['add', '-b', 'linked', linked]);
		await source.git('worktree', ['add', '-b', 'sibling', sibling]);
		await source.git('branch', ['published']);
		const references = await source.git('for-each-ref');
		const linkedGitDirectory = await createGit(linked)('rev-parse', ['--absolute-git-dir']);
		for (const destination of [source.path, sibling, linkedGitDirectory]) {
			const result = await gitPublish(linked, ['--fresh', '--remote', destination, '--branch', 'published']);
			expect(('exitCode' in result) && result.exitCode).toBe(1);
			expect(result.output).toContain('Refusing to push to the source repository.');
			expect(await source.git('for-each-ref')).toBe(references);
		}
	});

	test('checks the repository Git opens via the .git suffix fallback', async () => {
		await using fixture = await createFixture({
			'source.git/package.json': '{"name":"app","version":"1.0.0"}',
			destination: {},
			'destination.git': {},
		});
		const source = createGit(fixture.getPath('source.git'));
		const destination = createGit(fixture.getPath('destination.git'));
		await source.init();
		await destination.init(['--bare']);
		await source('add', ['.']);
		await source('commit', ['-m', 'initial']);
		await source('branch', ['published']);
		const references = await source('for-each-ref');
		const result = await gitPublish(fixture.getPath('source.git'), ['--fresh', '--branch', 'published', '--remote', fixture.getPath('source')]);
		expect(('exitCode' in result) && result.exitCode).toBe(1);
		expect(result.output).toContain('Refusing to push to the source repository.');
		expect(await source('for-each-ref')).toBe(references);
		const separate = await gitPublish(fixture.getPath('source.git'), ['--fresh', '--branch', 'published', '--remote', fixture.getPath('destination')]);
		expect('exitCode' in separate).toBe(false);
		expect(await destination('rev-parse', ['published'])).toMatch(/^[0-9a-f]{40}$/);
	});

	test('rejects a whitespace-containing remote before dry-run output', async () => {
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
		});
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		const result = await gitPublish(fixture.path, ['--dry', '--remote', 'https://user:hello secret@host/repo.git']);
		expect('exitCode' in result && result.exitCode).not.toBe(false);
		expect(result.stdout + result.stderr).not.toContain('secret');
	});

	test('rejects embedded newlines in configured remote URLs', async () => {
		await using fixture = await createGitFixture();
		await fixture.git('remote', ['add', 'origin', 'https://host/repo.git']);
		await fixture.git('config', ['remote.origin.url', 'https://host/repo.git\nsecret']);
		const result = getPublishRemote(fixture.path, 'origin', true);
		await expect(result).rejects.toThrow('Remote "origin" uses a URL');
		await expect(result).rejects.not.toThrow('secret');
	});

	test('names the configured remote when rejecting an IPv6 SCP host', async () => {
		await using fixture = await createGitFixture();
		await fixture.git('remote', ['add', 'origin', 'git@[2001:db8::1]:repo.git']);
		await expect(getPublishRemote(fixture.path, 'origin', true)).rejects.toThrow('Remote "origin" uses a URL that package managers cannot install from.');
	});
	test('publishes to a local path containing a hash', async () => {
		await using destination = await createFixture();
		const remotePath = destination.getPath('repo#1');
		await fs.mkdir(remotePath);
		const remoteGit = createGit(remotePath);
		await remoteGit.init(['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
		}, ['--initial-branch=source']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		const result = await gitPublish(fixture.path, ['--remote', remotePath]);
		expect('exitCode' in result).toBe(false);
		expect(result.stdout).toContain('repo%231');
		expect(await remoteGit('rev-parse', ['npm/source'])).toMatch(/^[0-9a-f]{40}$/);
	});
	test('rejects an unsupported fetch URL before packing even with a local push destination', async () => {
		await using destination = await createGitFixture(undefined, ['--bare']);
		await using marker = await createFixture();
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				scripts: { prepack: `node -e "require('node:fs').writeFileSync('${marker.getPath('packed')}', '')"` },
			}),
		}, ['--initial-branch=source']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('remote', ['add', 'origin', 's3://user:secret@bucket/repo.git']);
		await fixture.git('config', ['remote.origin.pushurl', destination.path]);
		const result = await gitPublish(fixture.path);
		expect('exitCode' in result && result.exitCode).not.toBe(false);
		expect(result.stdout + result.stderr).toContain('Remote "origin" uses a URL that package managers cannot install from.');
		expect(result.stdout + result.stderr).not.toContain('secret');
		expect(await marker.exists('packed')).toBe(false);
		expect(await destination.git('for-each-ref')).toBe('');
	});

	for (const [label, pushUrl] of [
		['hosted scp query', 'git@github.com:fork/r.git?token=secret'],
		['hosted helper', 'github.com::user:secret@host/repo.git'],
	] as const) {
		test(`rejects ${label} before destination selection`, async () => {
			await using fixture = await createGitFixture();
			await fixture.git('remote', ['add', 'origin', 'https://github.com/a/r.git']);
			await fixture.git('config', ['remote.origin.pushurl', pushUrl]);
			const result = getPublishRemote(fixture.path, 'origin', true);
			await expect(result).rejects.toThrow('Remote "origin" uses a URL that package managers cannot install from.');
			await expect(result).rejects.not.toThrow('secret');
		});
	}
	test('rejects unsupported install transports before packing', async () => {
		await using marker = await createFixture();
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				scripts: { prepack: `node -e "require('node:fs').writeFileSync('${marker.getPath('packed')}', '')"` },
			}),
		});
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		const result = await gitPublish(fixture.path, ['--remote', 's3://key:secret@bucket/repo.git']);
		expect('exitCode' in result && result.exitCode).not.toBe(false);
		expect(result.stdout + result.stderr).toContain('The remote URL uses a URL that package managers cannot install from.');
		expect(result.stdout).not.toContain('secret');
		expect(result.stderr).not.toContain('secret');
		expect(await marker.exists('packed')).toBe(false);
	});

	test('rejects single-letter helper syntax during remote resolution', async () => {
		await using fixture = await createGitFixture();
		await expect(getPublishRemote(fixture.path, 'x::address', false)).rejects.toThrow('The remote URL uses a URL that package managers cannot install from.');
	});

	test('names configured remotes without exposing their URLs', async () => {
		await using fixture = await createGitFixture();
		await fixture.git('remote', ['add', 'origin', 's3://user:secret@host/r']);
		const result = getPublishRemote(fixture.path, 'origin', true);
		await expect(result).rejects.toThrow('Remote "origin" uses a URL that package managers cannot install from.');
		await expect(result).rejects.not.toThrow('secret');
	});

	if (process.platform !== 'win32') {
		test('rejects single-letter URL remotes before local normalization', async () => {
			await using fixture = await createGitFixture();
			const result = getPublishRemote(fixture.path, 'x://user:secret@host/r', false);
			await expect(result).rejects.toThrow('The remote URL uses a URL');
			await expect(result).rejects.not.toThrow('secret');
		});
	}

	test('prints the rejection reason for a standalone push', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		const hook = remote.getPath('hooks/pre-receive');
		await fs.writeFile(hook, '#!/bin/sh\necho "push rejected by test hook" >&2\nexit 1\n');
		await fs.chmod(hook, 0o755);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
		});
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		const result = await gitPublish(fixture.path);
		expect(('exitCode' in result) && result.exitCode).toBe(1);
		expect(result.stdout).toContain('push rejected by test hook');
	});
	test('selects install and history URLs by destination identity', () => {
		expect(getPublicationUrls('https://alice@host/repo.git', 'https://bob@host/repo.git', '/repo').historyUrl)
			.toBe('https://alice@host/repo.git');
		expect(getPublicationUrls('git@host:repo.git', 'ssh://git@host/~/repo', '/repo').historyUrl)
			.toBe('git@host:repo.git');
		expect(getPublicationUrls('git@host:repo.git', 'git@host:/repo.git', '/repo').historyUrl)
			.toBe('git@host:/repo.git');
		expect(getPublicationUrls('a@host:repo.git', 'b@host:repo.git', '/repo').historyUrl)
			.toBe('b@host:repo.git');
		expect(getPublicationUrls('https://GitHub.com/owner/repo.git', 'git@github.com:owner/repo', '/repo'))
			.toStrictEqual({
				installUrl: 'https://GitHub.com/owner/repo.git',
				historyUrl: 'https://GitHub.com/owner/repo.git',
			});
		expect(getPublicationUrls('https://github.com/upstream/r.git', 'git@github.com:me/r.git', '/repo'))
			.toStrictEqual({
				installUrl: 'https://github.com/me/r.git',
				historyUrl: 'git@github.com:me/r.git',
			});
		expect(getPublicationUrls('git@github.com:upstream/r.git', 'https://github.com/me/r', '/repo'))
			.toStrictEqual({
				installUrl: 'git@github.com:me/r.git',
				historyUrl: 'https://github.com/me/r',
			});
		for (const host of ['gitlab.com', 'bitbucket.org']) {
			expect(getPublicationUrls(`ssh://git@${host}/upstream/r.git`, `https://${host}/me/r.git`, '/repo'))
				.toStrictEqual({
					installUrl: `ssh://git@${host}/me/r.git`,
					historyUrl: `https://${host}/me/r.git`,
				});
		}
		expect(getPublicationUrls('ssh://git@example.test/a.git', 'ssh://git@example.test/b.git', '/repo'))
			.toStrictEqual({
				installUrl: 'ssh://git@example.test/b.git',
				historyUrl: 'ssh://git@example.test/b.git',
			});
		expect(getPublicationUrls('./remote', '/repo/remote', '/repo'))
			.toStrictEqual({
				installUrl: './remote',
				historyUrl: './remote',
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

	test('publishes to an option-like configured remote name', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
		}, ['--initial-branch=source']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('config', ['remote.-mirror.url', remote.path]);
		const result = await gitPublish(fixture.path, ['--remote=-mirror']);
		expect('exitCode' in result).toBe(false);
		expect(await remote.git('rev-parse', ['npm/source'])).toMatch(/^[0-9a-f]{40}$/);
	});

	for (const count of [1, 2]) {
		test(`rejects a push-only remote with ${count} push URL${count === 1 ? '' : 's'} before packing`, async () => {
			await using first = await createGitFixture(undefined, ['--bare']);
			await using second = await createGitFixture(undefined, ['--bare']);
			await using marker = await createFixture();
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: `node -e "require('node:fs').writeFileSync('${marker.getPath('packed')}', '')"` },
				}),
			}, ['--initial-branch=source']);
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'initial']);
			await fs.mkdir(fixture.getPath('pushonly'));
			const local = createGit(fixture.getPath('pushonly'));
			await local.init(['--bare']);
			await fixture.git('config', ['--add', 'remote.pushonly.pushurl', first.path]);
			if (count === 2) {
				await fixture.git('config', ['--add', 'remote.pushonly.pushurl', second.path]);
			}
			const result = await gitPublish(fixture.path, ['--remote', 'pushonly']);
			expect(('exitCode' in result) && result.exitCode).toBe(1);
			expect(result.output).toContain('Remote "pushonly" has no fetch URL configured or remaining after an empty URL reset.');
			expect(await marker.exists('packed')).toBe(false);
			expect(await local('for-each-ref')).toBe('');
			expect(await first.git('for-each-ref')).toBe('');
			expect(await second.git('for-each-ref')).toBe('');
		});
	}

	test('does not expose a URL-shaped push-only remote name', async () => {
		await using fixture = await createGitFixture();
		const name = 'https://user:secret@example.test/repo';
		await fixture.git('config', [`remote.${name}.pushurl`, 'https://example.test/a']);
		const result = getPublishRemote(fixture.path, name, false);
		await expect(result).rejects.toThrow('Selected remote has no fetch URL configured or remaining after an empty URL reset.');
		await expect(result).rejects.not.toThrow('secret');
		await expect(result).rejects.not.toThrow('example.test');
	});

	for (const pushToSeparateRemote of [false, true]) {
		test(`publishes after an empty pushurl ${pushToSeparateRemote ? 'followed by a destination' : 'falls back to url'}`, async () => {
			await using fetchRemote = await createGitFixture(undefined, ['--bare']);
			await using pushRemote = await createGitFixture(undefined, ['--bare']);
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
				}),
			}, ['--initial-branch=source']);
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'initial']);
			await fixture.git('branch', ['npm/reset']);
			const sourceBranch = await fixture.git('rev-parse', ['npm/reset']);
			await fixture.git('remote', ['add', 'origin', fetchRemote.path]);
			await fixture.git('config', ['--add', 'remote.origin.pushurl', '']);
			if (pushToSeparateRemote) {
				await fixture.git('config', ['--add', 'remote.origin.pushurl', pushRemote.path]);
			}
			const result = await gitPublish(fixture.path, ['--branch', 'npm/reset', '--fresh']);
			expect('exitCode' in result).toBe(false);
			expect(await fixture.git('rev-parse', ['npm/reset'])).toBe(sourceBranch);
			const destination = pushToSeparateRemote ? pushRemote : fetchRemote;
			expect(await destination.git('rev-parse', ['npm/reset'])).toMatch(/^[0-9a-f]{40}$/);
			if (pushToSeparateRemote) {
				expect(await fetchRemote.git('for-each-ref')).toBe('');
			}
		});
	}

	test('rejects multiple urls after an empty pushurl resets the push list', async () => {
		await using first = await createGitFixture(undefined, ['--bare']);
		await using second = await createGitFixture(undefined, ['--bare']);
		await using marker = await createFixture();
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				scripts: { prepack: `node -e "require('node:fs').writeFileSync('${marker.getPath('packed')}', '')"` },
			}),
		});
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'initial']);
		await fixture.git('remote', ['add', 'origin', first.path]);
		await fixture.git('config', ['--add', 'remote.origin.url', second.path]);
		await fixture.git('config', ['--add', 'remote.origin.pushurl', '']);
		const result = await gitPublish(fixture.path);
		expect(('exitCode' in result) && result.exitCode).toBe(1);
		expect(result.output).toContain('Remote "origin" has 2 push URLs.');
		expect(await marker.exists('packed')).toBe(false);
		expect(await first.git('for-each-ref')).toBe('');
		expect(await second.git('for-each-ref')).toBe('');
	});

	test('uses url entries after the last empty url', async () => {
		await using fixture = await createGitFixture();
		await fixture.git('remote', ['add', 'origin', 'https://example.test/a.git']);
		await fixture.git('config', ['--add', 'remote.origin.url', '']);
		await fixture.git('config', ['--add', 'remote.origin.url', 'https://example.test/b.git']);
		const remote = await getPublishRemote(fixture.path, 'origin', true);
		expect(remote.installUrl).toBe('https://example.test/b.git');
		expect(remote.pushUrl).toBe('https://example.test/b.git');
	});

	test('falls back to url after a trailing empty pushurl resets earlier destinations', async () => {
		await using fixture = await createGitFixture();
		await fixture.git('remote', ['add', 'origin', 'https://example.test/a.git']);
		for (const url of ['https://example.test/b.git', 'https://example.test/c.git', '']) {
			await fixture.git('config', ['--add', 'remote.origin.pushurl', url]);
		}
		const remote = await getPublishRemote(fixture.path, 'origin', true);
		expect(remote.pushUrl).toBe('https://example.test/a.git');
	});

	test('rejects a configured remote whose url list is reset to empty', async () => {
		await using fixture = await createGitFixture();
		await fixture.git('remote', ['add', 'origin', 'https://example.test/a.git']);
		await fixture.git('config', ['--add', 'remote.origin.url', '']);
		await fixture.git('config', ['remote.origin.pushurl', 'https://example.test/b.git']);
		await expect(getPublishRemote(fixture.path, 'origin', false)).rejects.toThrow('Remote "origin" has no fetch URL configured or remaining after an empty URL reset.');
	});

	for (const key of ['url', 'pushurl']) {
		test(`rejects a valueless ${key} before packing`, async () => {
			await using remote = await createGitFixture(undefined, ['--bare']);
			await using marker = await createFixture();
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: `node -e "require('node:fs').writeFileSync('${marker.getPath('packed')}', '')"` },
				}),
			});
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'initial']);
			await fixture.git('remote', ['add', 'origin', remote.path]);
			await fs.appendFile(fixture.getPath('.git/config'), `\n[remote "origin"]\n\t${key}\n\t${key} = ${remote.path}\n`);
			const result = await gitPublish(fixture.path);
			expect(('exitCode' in result) && result.exitCode).toBe(1);
			expect(result.output).toContain('Remote "origin" has invalid Git remote configuration.');
			expect(result.output).not.toContain(remote.path);
			expect(await marker.exists('packed')).toBe(false);
			expect(await remote.git('for-each-ref')).toBe('');
		});
	}

	test('does not expose URL-shaped remote names when Git rejects their configuration', async () => {
		await using fixture = await createGitFixture();
		const name = 'https://user:secret@example.test/repo';
		await fixture.git('config', [`remote.${name}.url`, 'https://example.test/a']);
		await fs.appendFile(fixture.getPath('.git/config'), `\n[remote "${name}"]\n\tpushurl\n\tpushurl = https://example.test/b\n`);
		const result = getPublishRemote(fixture.path, name, false);
		await expect(result).rejects.toThrow('Selected remote has invalid Git remote configuration.');
		await expect(result).rejects.not.toThrow('secret');
		await expect(result).rejects.not.toThrow('example.test');
	});

	for (const key of ['url', 'pushurl']) {
		test(`rejects multiple ${key} destinations before packing`, async () => {
			await using first = await createGitFixture(undefined, ['--bare']);
			await using second = await createGitFixture(undefined, ['--bare']);
			await using marker = await createFixture();
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: `node -e "require('node:fs').writeFileSync('${marker.getPath('packed')}', '')"` },
				}),
			});
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'initial']);
			await fixture.git('remote', ['add', 'origin', first.path]);
			if (key === 'pushurl') {
				await fixture.git('config', ['--add', 'remote.origin.pushurl', first.path]);
			}
			await fixture.git('config', ['--add', `remote.origin.${key}`, second.path]);
			const result = await gitPublish(fixture.path);
			expect(('exitCode' in result) && result.exitCode).toBe(1);
			expect(result.output).toContain('Remote "origin" has 2 push URLs. Use one remote per destination or --remote <url>.');
			expect(result.output).not.toContain(first.path);
			expect(result.output).not.toContain(second.path);
			expect(await marker.exists('packed')).toBe(false);
			expect(await first.git('for-each-ref')).toBe('');
			expect(await second.git('for-each-ref')).toBe('');
		});
	}

	test('does not expose URL-shaped configured remote names or destination credentials', async () => {
		await using fixture = await createGitFixture();
		const name = 'https://user:secret@example.test/repo';
		await fixture.git('config', ['--add', `remote.${name}.url`, 'https://user:other-secret@example.test/a']);
		await fixture.git('config', ['--add', `remote.${name}.url`, 'https://example.test/b']);
		const result = getPublishRemote(fixture.path, name, false);
		await expect(result).rejects.toThrow('Selected remote has 2 push URLs.');
		await expect(result).rejects.not.toThrow('secret');
		await expect(result).rejects.not.toThrow('example.test');
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
		const token = await gitPublish(fixture.path, ['--dry', '--remote', 'https://ghp_secret@github.com/o/r.git']);
		expect('exitCode' in token).toBe(false);
		expect(token.stdout).not.toContain('ghp_secret');
		expect(token.stdout).toContain('https://[redacted]');
		expect(token.stderr).not.toContain('ghp_secret');
		const query = await gitPublish(fixture.path, ['--dry', '--remote', 'https://host/repo.git?access_token=secret']);
		expect('exitCode' in query).toBe(true);
		expect(query.stdout).not.toContain('secret');
		expect(query.stderr).not.toContain('secret');
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
