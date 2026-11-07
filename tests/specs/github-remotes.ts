import { describe, test, expect } from 'manten';
import { getGitHubInstallSpecifier, getGitHubRepositoryName, isHostedGitRemote } from '../../src/utils/git-url.ts';

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
