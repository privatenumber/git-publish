import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import { getPublicationUrls } from '../../src/publish-repository/destination.ts';
import { getPublishRemote } from '../../src/publish-repository/remote.ts';
import { createGit, createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Remote transport', async () => {
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

	test('publishes to a local path containing a newline by name and literal URL', async () => {
		await using destination = await createFixture({ 'repo\n': {} });
		const remotePath = destination.getPath('repo\n');
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
		await fixture.git('remote', ['add', 'origin', remotePath]);
		const rewritePrefix = `${destination.path}/unrewritten\n/`;
		await fixture.git('config', [`url.${destination.path}/.pushInsteadOf`, rewritePrefix]);

		for (const [remote, branch] of [
			[remotePath, 'literal'],
			['origin', 'named'],
			[`${rewritePrefix}repo\n`, 'rewritten'],
		] as const) {
			const result = await gitPublish(fixture.path, ['--remote', remote, '--branch', branch]);
			expect(result.output).toContain(`git+${pathToFileURL(remotePath).href}#${branch}`);
			expect(await remoteGit('rev-parse', [`refs/heads/${branch}`])).toMatch(/^[0-9a-f]{40}$/);
		}
	});

	test('preserves a trailing carriage return in resolved local URLs', async () => {
		await using destination = await createFixture({
			repo: {},
			'repo\r': {},
		});
		const remotePath = destination.getPath('repo\r');
		const remoteGit = createGit(remotePath);
		const siblingGit = createGit(destination.getPath('repo'));
		await remoteGit.init(['--bare']);
		await siblingGit.init(['--bare']);
		await using source = await createGitFixture({
			'package.json': '{"name":"app","version":"1.0.0"}',
		});
		await source.git('add', ['.']);
		await source.git('commit', ['-m', 'initial']);
		await source.git('remote', ['add', 'origin', remotePath]);
		const alias = destination.getPath('alias');
		await source.git('config', [`url.${remotePath}.insteadOf`, alias]);

		for (const [remote, branch] of [
			['origin', 'named'],
			[alias, 'literal'],
		] as const) {
			const result = await gitPublish(source.path, ['--remote', remote, '--branch', branch]);
			onTestFail(() => console.log(result));
			expect('exitCode' in result).toBe(false);
			expect(result.stdout).toContain(`git+${pathToFileURL(remotePath).href}#${branch}`);
		}
		expect(await remoteGit('for-each-ref', ['--format=%(refname)'])).toBe('refs/heads/literal\nrefs/heads/named');
		expect(await siblingGit('for-each-ref')).toBe('');
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
		// The hook prints more lines after the reason than a short preview holds
		await fs.writeFile(hook, '#!/bin/sh\necho "push rejected by test hook" >&2\nfor i in 1 2 3 4 5 6 7 8 9 10; do echo "noise $i" >&2; done\nexit 1\n');
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
		expect(result.stdout).not.toMatch(/\(\+ \d+ lines\)/);
	});
	test('selects the install URL and history transport by destination identity', () => {
		expect(getPublicationUrls('https://alice@host/repo.git', 'https://bob@host/repo.git', '/repo').useFetchForHistory)
			.toBe(true);
		expect(getPublicationUrls('git@host:repo.git', 'ssh://git@host/~/repo.git', '/repo').useFetchForHistory)
			.toBe(true);
		expect(getPublicationUrls('git@host:repo.git', 'git@host:/repo.git', '/repo').useFetchForHistory)
			.toBe(false);
		expect(getPublicationUrls('a@host:repo.git', 'b@host:repo.git', '/repo').useFetchForHistory)
			.toBe(false);
		expect(getPublicationUrls('https://GitHub.com/owner/repo.git', 'git@github.com:owner/repo', '/repo'))
			.toStrictEqual({
				installUrl: 'https://GitHub.com/owner/repo.git',
				useFetchForHistory: true,
			});
		expect(getPublicationUrls('https://github.com/upstream/r.git', 'git@github.com:me/r.git', '/repo'))
			.toStrictEqual({
				installUrl: 'https://github.com/me/r.git',
				useFetchForHistory: false,
			});
		expect(getPublicationUrls('git@github.com:upstream/r.git', 'https://github.com/me/r', '/repo'))
			.toStrictEqual({
				installUrl: 'git@github.com:me/r.git',
				useFetchForHistory: false,
			});
		for (const host of ['gitlab.com', 'bitbucket.org']) {
			expect(getPublicationUrls(`ssh://git@${host}/upstream/r.git`, `https://${host}/me/r.git`, '/repo'))
				.toStrictEqual({
					installUrl: `ssh://git@${host}/me/r.git`,
					useFetchForHistory: false,
				});
		}
		expect(getPublicationUrls('ssh://git@example.test/a.git', 'ssh://git@example.test/b.git', '/repo'))
			.toStrictEqual({
				installUrl: 'ssh://git@example.test/b.git',
				useFetchForHistory: false,
			});
		expect(getPublicationUrls('./remote', '/repo/remote', '/repo'))
			.toStrictEqual({
				installUrl: './remote',
				useFetchForHistory: true,
			});
	});

	for (const mode of [
		'pushurl',
		'relative pushInsteadOf',
		'absolute pushInsteadOf',
		'literal URL with pushInsteadOf',
		'generic SSH',
	] as const) {
		test(`checks tags at the push destination with ${mode}`, async () => {
			await using fixture = await createFixture({
				'mirror.git': {},
				'fork=preview.git': {},
				source: {
					'package.json': JSON.stringify({
						name: 'app',
						version: '1.0.0',
					}),
				},
			});
			const source = fixture.getPath('source');
			const mirrorPath = fixture.getPath('mirror.git');
			const pushPath = fixture.getPath('fork=preview.git');
			const git = createGit(source);
			const mirror = createGit(mirrorPath);
			const destination = createGit(pushPath);
			await Promise.all([
				git.init(['--initial-branch=source']),
				mirror.init(['--bare']),
				destination.init(['--bare']),
			]);
			await git('add', ['.']);
			await git('commit', ['-m', 'Initial commit']);
			const tag = 'refs/tags/npm/source';
			await git('update-ref', [tag, 'HEAD']);
			await git('push', [pushPath, tag]);
			let installUrl = pathToFileURL(pushPath).href;
			const literalUrl = pathToFileURL(mirrorPath).href;
			const remoteArguments = mode === 'literal URL with pushInsteadOf' ? ['--remote', literalUrl] : [];
			if (mode === 'generic SSH') {
				const fetchUrl = 'ssh://git@example.test/remote';
				const pushUrl = `${fetchUrl}.git`;
				await git('remote', ['add', 'origin', fetchUrl]);
				await git('config', ['remote.origin.pushurl', pushUrl]);
				await git('config', [`url.${mirrorPath}.insteadOf`, fetchUrl]);
				await git('config', [`url.${pushPath}.insteadOf`, pushUrl]);
				installUrl = pushUrl;
			} else {
				const fetchUrl = mode === 'relative pushInsteadOf' ? '../mirror.git' : mirrorPath;
				await git('remote', ['add', 'origin', fetchUrl]);
				await git('config', mode === 'pushurl'
					? ['remote.origin.pushurl', pushPath]
					: [`url.${pushPath}.pushInsteadOf`, remoteArguments.length ? literalUrl : fetchUrl]);
				if (mode === 'pushurl') {
					await git('config', [`url.${mirrorPath}.pushInsteadOf`, pushPath]);
				} else if (remoteArguments.length) {
					await git('config', [`url.${mirrorPath}.insteadOf`, literalUrl]);
				}
			}
			for (const arguments_ of [remoteArguments, [...remoteArguments, '--fresh']]) {
				const result = await gitPublish(source, arguments_);
				expect(result.output).toContain(`Remote ref "${tag}" conflicts with publish branch "npm/source"`);
			}
			expect(await destination('for-each-ref', ['--format=%(refname)'])).toBe(tag);
			await destination('update-ref', ['-d', tag]);
			const result = await gitPublish(source, remoteArguments);
			expect('exitCode' in result).toBe(false);
			expect(result.stdout).toContain(`git+${installUrl}#npm/source`);
			expect(await destination('for-each-ref', ['--format=%(refname)'])).toBe('refs/heads/npm/source');
			expect(await mirror('for-each-ref')).toBe('');
		});
	}

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

	test('redacts a URL-shaped remote name when its only destination is invalid', async () => {
		await using fixture = await createGitFixture();
		const name = 'https://user:secret@example.test/repo';
		await fixture.git('config', [`remote.${name}.url`, 's3://user:other-secret@host/repo']);
		const result = getPublishRemote(fixture.path, name, false);
		await expect(result).rejects.toThrow('The remote URL uses a URL that package managers cannot install from.');
		await expect(result).rejects.not.toThrow('secret');
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

	test('does not inherit command-scope URLs for generated publication remotes', async () => {
		await using destination = await createGitFixture(undefined, ['--bare']);
		await using other = await createGitFixture(undefined, ['--bare']);
		await using source = await createGitFixture({
			'package.json': '{"name":"app","version":"1.0.0"}',
		}, ['--initial-branch=source']);
		await source.git('add', ['.']);
		await source.git('commit', ['-m', 'Initial commit']);
		await source.git('remote', ['add', 'origin', destination.path]);
		// Use different URLs for history and push, both pointing at the intended repo.
		await source.git('config', ['remote.origin.pushurl', pathToFileURL(destination.path).href]);

		const environment = {
			GIT_CONFIG_COUNT: '3',
			GIT_CONFIG_KEY_0: 'remote.publish.pushurl',
			GIT_CONFIG_VALUE_0: other.path,
			// Reset the history URL before appending, so Git would read from other.
			GIT_CONFIG_KEY_1: 'remote.publish-source.url',
			GIT_CONFIG_VALUE_1: '',
			GIT_CONFIG_KEY_2: 'remote.publish-source.url',
			GIT_CONFIG_VALUE_2: other.path,
		};
		const result = await gitPublish(source.path, [], environment);
		onTestFail(() => console.log(result));
		expect('exitCode' in result).toBe(false);
		expect(await destination.git('for-each-ref', ['--format=%(refname)'])).toBe('refs/heads/npm/source');
		expect(await other.git('for-each-ref')).toBe('');
		const repeat = await gitPublish(source.path, [], environment);
		expect('exitCode' in repeat).toBe(false);
		expect(repeat.stdout).toContain('Unchanged; reusing existing commit');
	});

	for (const kind of ['relative', 'absolute']) {
		test(`prints an installable URL for a rewritten ${kind} filesystem path`, async () => {
			await using destination = await createGitFixture(undefined, ['--bare']);
			await using source = await createGitFixture({
				'package.json': '{"name":"app","version":"1.0.0"}',
			}, ['--initial-branch=source']);
			await using consumer = await createFixture({ 'package.json': '{}' });
			await source.git('add', ['.']);
			await source.git('commit', ['-m', 'Initial commit']);
			const alias = kind === 'relative' ? '../alias.git' : source.getPath('alias.git');
			await source.git('remote', ['add', 'origin', alias]);
			const globalConfig = consumer.getPath('gitconfig');
			await spawn('git', ['config', '--file', globalConfig, `url.${destination.path}.insteadOf`, alias]);
			const result = await gitPublish(source.path, [], { GIT_CONFIG_GLOBAL: globalConfig });
			onTestFail(() => console.log(result));
			expect('exitCode' in result).toBe(false);
			const specifier = `git+${pathToFileURL(destination.path).href}#npm/source`;
			expect(result.stdout).toContain(`npm i '${specifier}'`);
			await destination.git('symbolic-ref', ['HEAD', 'refs/heads/npm/source']);
			await spawn('npm', ['install', '--allow-git=root', '--no-audit', '--no-fund', specifier], {
				cwd: consumer.path,
			});
			expect(await consumer.exists('node_modules/app/package.json')).toBe(true);
		});
	}

	for (const kind of ['named', 'literal']) {
		test(`ignores an empty push-only rewrite for a ${kind} remote`, async () => {
			await using destination = await createGitFixture(undefined, ['--bare']);
			await using source = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'standalone',
					version: '1.0.0',
				}),
			}, ['--initial-branch=source']);
			await source.git('add', ['.']);
			await source.git('commit', ['-m', 'Initial commit']);
			await source.git('remote', ['add', 'origin', destination.path]);
			await source.git('config', ['url..pushInsteadOf', destination.path]);

			const remote = kind === 'named' ? 'origin' : destination.path;
			const result = await gitPublish(source.path, ['--remote', remote]);
			onTestFail(() => console.log(result));
			expect('exitCode' in result).toBe(false);
			expect(await source.git('for-each-ref', ['--format=%(refname)', 'refs/heads'])).toBe('refs/heads/source');
			expect(await destination.git('for-each-ref', ['--format=%(refname)'])).toBe('refs/heads/npm/source');
		});
	}

	test('rejects a named push URL rewritten to an empty string', async () => {
		await using source = await createGitFixture();
		await source.git('remote', ['add', 'origin', './fetch.git']);
		await source.git('config', ['remote.origin.pushurl', './push.git']);
		await source.git('config', ['url..insteadOf', './push.git']);
		await expect(getPublishRemote(source.path, 'origin', true)).rejects.toThrow(
			'Remote "origin" has invalid Git remote configuration.',
		);
	});

	for (const [kind, rewriteScope] of [
		['literal', 'global'],
		['named', 'local'],
		['named', 'command'],
	] as const) {
		test(`does not rewrite the ${kind} push destination again with ${rewriteScope} config`, async () => {
			await using upstream = await createGitFixture(undefined, ['--bare']);
			await using fork = await createGitFixture(undefined, ['--bare']);
			await using other = await createGitFixture(undefined, ['--bare']);
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'standalone',
					version: '1.0.0',
				}),
			}, ['--initial-branch=chained']);
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', upstream.path]);
			await fixture.git('config', [`url.${fork.path}.pushInsteadOf`, upstream.path]);
			const key = `url.${other.path}.insteadOf`;
			const environment: NodeJS.ProcessEnv = {};
			if (rewriteScope === 'global') {
				environment.GIT_CONFIG_GLOBAL = upstream.getPath('global-config');
				await spawn('git', ['config', '--file', environment.GIT_CONFIG_GLOBAL, key, fork.path]);
			} else if (rewriteScope === 'command') {
				environment.GIT_CONFIG_COUNT = '1';
				environment.GIT_CONFIG_KEY_0 = key;
				environment.GIT_CONFIG_VALUE_0 = fork.path;
			} else {
				await fixture.git('config', [key, fork.path]);
			}
			const args = kind === 'literal' ? ['--remote', upstream.path] : [];
			const result = await gitPublish(fixture.path, args, environment);
			onTestFail(() => console.log(result));
			expect('exitCode' in result).toBe(false);
			expect(result.stdout).toContain(`git+file://${fork.path}#npm/chained`);
			const tip = await fork.git('rev-parse', ['refs/heads/npm/chained']);
			expect(tip).toMatch(/^[0-9a-f]{40}$/);
			expect(await other.git('for-each-ref')).toBe('');
			expect(await upstream.git('for-each-ref')).toBe('');

			const repeat = await gitPublish(fixture.path, args, environment);
			expect('exitCode' in repeat).toBe(false);
			expect(await fork.git('rev-parse', ['refs/heads/npm/chained'])).toBe(tip);
		});
	}

	test('prints the configured hosted fork when its push URL is rewritten locally', async () => {
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
		const specifier = 'git+https://github.com/fork/repo.git#npm/hosted';
		expect(result.stdout).toContain("npm i 'fork/repo#npm/hosted'");
		expect(await output.readFile('result.json', 'utf8')).toContain(specifier);
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

	test('honors command-scope receive-pack for the selected configured remote', async () => {
		await using destination = await createGitFixture(undefined, ['--bare']);
		await using source = await createGitFixture({
			'package.json': '{"name":"app","version":"1.0.0"}',
		}, ['--initial-branch=source']);
		await source.git('add', ['.']);
		await source.git('commit', ['-m', 'initial']);

		for (const [remote, command] of [
			['publish', '/usr/bin/false'],
			['fixture', '/usr/bin/false'],
			['fixture', 'git-receive-pack'],
		] as const) {
			if (command === 'git-receive-pack') {
				// Git keeps the first receive-pack, even when command config sets another.
				await source.git('config', [`remote.${remote}.receivepack`, '/usr/bin/false']);
			} else {
				await source.git('remote', ['add', remote, destination.path]);
			}
			const result = await gitPublish(source.path, ['--remote', remote], {
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: `remote.${remote}.receivepack`,
				GIT_CONFIG_VALUE_0: command,
			});
			onTestFail(() => console.log(result));
			expect('exitCode' in result && result.exitCode).toBe(1);
			expect(result.output).toContain('Could not read from remote repository');
			expect(await destination.git('for-each-ref')).toBe('');
		}
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
