import { describe, expect, test } from 'manten';
import { createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Standalone branch templates', () => {
	test('rejects ambiguous bare selectors during planning, including dry runs', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-package',
				version: '1.0.0',
			}),
		}, ['--initial-branch=feature/a&b']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		for (const branch of [
			"preview/it's",
			'preview/a#b',
			'refs/tags/test-package',
			'heads/core',
			'tags/core',
			'remotes/core',
			'@',
			'HeAd',
			'FETCH_HEAD',
			'ORIG_HEAD',
			'ABC',
			'_',
			'abcdef0',
			'A'.repeat(40),
			'a'.repeat(64),
			'-main',
			'a..b',
			'npm/.a',
		]) {
			const result = await gitPublish(fixture.path, ['--dry', `--branch=${branch}`]);
			expect('exitCode' in result && result.exitCode).toBe(1);
			expect(result.output).toContain(`Invalid publish branch "${branch}"`);
			expect(result.output).toContain("--branch 'preview/{package}'");
		}
		const result = await gitPublish(fixture.path, ['--dry']);
		expect('exitCode' in result && result.exitCode).toBe(1);
		expect(result.output).toContain('Invalid publish branch "npm/feature/a&b"');
		expect(await remote.git('for-each-ref')).toBe('');
	});
	for (const {
		title,
		template,
		branch,
	} of [
			{
				title: 'renders {gitRef}',
				template: 'preview/{gitRef}',
				branch: (_sourceCommit: string) => 'preview/feature/auth',
			},
			{
				title: 'renders the full {gitSha}',
				template: 'preview/{gitSha}',
				branch: (sourceCommit: string) => `preview/${sourceCommit}`,
			},
			{
				title: 'keeps literal branches exact',
				template: 'preview',
				branch: (_sourceCommit: string) => 'preview',
			},
			{
				title: 'uses a portable default branch for a normal source name',
				template: undefined,
				branch: (_sourceCommit: string) => 'npm/feature/auth',
			},
		]) {
		test(title, async () => {
			await using remoteFixture = await createGitFixture(undefined, ['--bare']);
			const { git: remoteGit } = remoteFixture;
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'test-package',
					version: '1.0.0',
				}),
			}, ['--initial-branch=feature/auth']);
			await fixture.git('add', ['package.json']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', remoteFixture.path]);
			const sourceCommit = await fixture.git('rev-parse', ['HEAD']);

			const gitPublishProcess = await gitPublish(fixture.path, template ? ['--branch', template] : []);

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(await remoteGit('show', [`${branch(sourceCommit)}:package.json`])).toContain('test-package');
		});
	}
});
