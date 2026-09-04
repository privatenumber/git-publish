import { describe, test, expect } from 'manten';
import { getGitHubRepositoryName } from '../../src/utils/github.ts';

describe('GitHub remotes', () => {
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
});
