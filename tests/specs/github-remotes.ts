import { pathToFileURL } from 'node:url';
import { describe, test, expect } from 'manten';
import {
	getGitHubInstallSpecifier, getGitHubRepositoryName, isHostedGitRemote, toPackageManagerGitUrl,
} from '../../src/utils/git-url.ts';

describe('package manager Git URLs', () => {
	for (const [input, expected] of [
		['ftp://user:secret@example.test/repo.git?token=secret', 'git+ftp://user@example.test/repo.git'],
		['git+ftp://user:secret@example.test/repo.git?token=secret', 'git+ftp://user@example.test/repo.git'],
		['rsync://user:secret@example.test/repo.git?token=secret', 'git+rsync://user@example.test/repo.git'],
		['git+rsync://user:secret@example.test/a/../repo.git?token=secret', 'git+rsync://user@example.test/a/../repo.git'],
		['git://user:secret@example.test/repo.git?token=secret', 'git://example.test/repo.git'],
	]) {
		test(`strips credentials from ${input.split(':')[0]} URLs to ${expected}`, () => {
			expect(toPackageManagerGitUrl(input)).toBe(expected);
		});
	}

	for (const input of ['s3://key:secret@bucket/repo.git', 'x::address', 'https::https://user:secret@host/r.git']) {
		test(`rejects unsupported remote ${input.split(':')[0]}`, () => {
			expect(() => toPackageManagerGitUrl(input)).toThrow('Cannot form an install URL for remote');
			try {
				toPackageManagerGitUrl(input);
			} catch (error) {
				expect(String(error)).not.toContain('secret');
			}
		});
	}

	test('redacts credentials in opaque helper addresses', () => {
		expect(() => toPackageManagerGitUrl('x::user:secret@host/r.git')).toThrow('Cannot form an install URL for remote');
		try {
			toPackageManagerGitUrl('x::user:secret@host/r.git');
		} catch (error) {
			expect(String(error)).toContain('Cannot form an install URL for remote');
			expect(String(error)).not.toContain('secret');
		}
	});

	test('preserves existing transport behavior', () => {
		expect(toPackageManagerGitUrl('https://user:secret@example.test/repo.git?token=secret')).toBe('git+https://example.test/repo.git');
		expect(toPackageManagerGitUrl('ssh://git:secret@example.test/repo.git?token=secret')).toBe('git+ssh://git@example.test/repo.git');
		expect(toPackageManagerGitUrl('git@example.test:repo.git')).toBe('git+ssh://git@example.test/~/repo.git');
		expect(toPackageManagerGitUrl('.')).toBe(`git+${pathToFileURL(process.cwd()).href}`);
		if (process.platform === 'win32') {
			expect(toPackageManagerGitUrl('C://work/repo.git')).toBe(`git+${pathToFileURL('C://work/repo.git', { windows: true }).href}`);
		} else {
			expect(() => toPackageManagerGitUrl('C://work/repo.git')).toThrow('Cannot form an install URL');
		}
	});

	for (const input of ['file:///repo.git?token=secret', 'file:///repo.git#secret']) {
		test(`rejects file URLs with ${input.includes('?') ? 'queries' : 'fragments'}`, () => {
			expect(() => toPackageManagerGitUrl(input)).toThrow('Cannot form an install URL');
			try {
				toPackageManagerGitUrl(input);
			} catch (error) {
				expect(String(error)).not.toContain('secret');
			}
		});
	}
});

describe('GitHub remotes', () => {
	test('recognizes authenticated GitHub URLs as hosted', () => {
		expect(isHostedGitRemote('https://token@github.com/o/r.git')).toBe(true);
	});
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

	test('formats GitHub install specifiers with shorthand', () => {
		expect(getGitHubInstallSpecifier(
			'git@github.com:owner/repository.git',
			'0123456789abcdef',
		)).toBe('owner/repository#0123456789abcdef');
		expect(getGitHubInstallSpecifier(
			'https://github.com/owner/repository.git',
			'main',
		)).toBe('owner/repository#main');
		expect(getGitHubInstallSpecifier(
			'git@example.com:owner/repository.git',
			'main',
		)).toBeUndefined();
	});
});
