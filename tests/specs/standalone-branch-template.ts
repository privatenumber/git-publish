import { describe, expect, test } from 'manten';
import { createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Standalone branch templates', () => {
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

			const gitPublishProcess = await gitPublish(fixture.path, ['--branch', template]);

			expect('exitCode' in gitPublishProcess).toBe(false);
			expect(await remoteGit('show', [`${branch(sourceCommit)}:package.json`])).toContain('test-package');
		});
	}
});
