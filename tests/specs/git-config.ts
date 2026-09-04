import fs from 'node:fs/promises';
import { describe, test, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import { getGitConfig, parseGitConfig, serializeGitConfig } from '../../src/publish-repository/git-config.ts';
import { createGit } from '../utils/create-git.ts';

describe('Git configuration', () => {
	test('round trips ordered entries through Git', async () => {
		await using fixture = await createFixture();
		const sourceConfigPath = fixture.getPath('source-config');
		const generatedConfigPath = fixture.getPath('generated-config');
		const entries = [
			['core.empty', ''],
			['core.repeated', 'first'],
			['core.repeated', 'second'],
			['core.quoted', '"quotes" and \\ backslashes\nwith\ttabs'],
			['branch.topic.with.dot.merge', 'refs/heads/main'],
		];
		for (const [key, value] of entries) {
			await spawn('git', ['config', '--file', sourceConfigPath, '--add', key, value]);
		}
		const sourceConfig = await spawn('git', ['config', '--file', sourceConfigPath, '--null', '--list']);
		const sourceEntries = parseGitConfig(sourceConfig.stdout, 'local');
		await fs.writeFile(generatedConfigPath, sourceEntries.map(serializeGitConfig).join(''));
		const generatedConfig = await spawn('git', ['config', '--file', generatedConfigPath, '--null', '--list']);

		expect(parseGitConfig(generatedConfig.stdout, 'local')).toStrictEqual(sourceEntries);
	});

	test('captures effective values from every scope and conditional includes', async () => {
		await using fixture = await createFixture();
		const git = createGit(fixture.path);
		await git.init();
		const systemConfigPath = fixture.getPath('system-config');
		const globalConfigPath = fixture.getPath('global-config');
		const includedConfigPath = fixture.getPath('included-config');
		await spawn('git', ['config', '--file', systemConfigPath, 'example.system', 'system']);
		await spawn('git', ['config', '--file', globalConfigPath, 'example.global', 'global']);
		await spawn('git', ['config', '--file', globalConfigPath, `includeIf.gitdir:${fixture.path}/.git.path`, includedConfigPath]);
		await spawn('git', ['config', '--file', includedConfigPath, 'example.included', 'included']);
		await git('config', ['example.local', 'local']);
		await git('config', ['extensions.worktreeConfig', 'true']);
		await git('config', ['--worktree', 'example.worktree', 'worktree']);

		const entries = await getGitConfig({
			cwd: fixture.path,
			env: {
				GIT_CONFIG_SYSTEM: systemConfigPath,
				GIT_CONFIG_GLOBAL: globalConfigPath,
			},
		});
		expect(entries).toEqual(expect.arrayContaining([
			{
				scope: 'system',
				key: 'example.system',
				value: 'system',
			},
			{
				scope: 'global',
				key: 'example.global',
				value: 'global',
			},
			{
				scope: 'global',
				key: 'example.included',
				value: 'included',
			},
			{
				scope: 'local',
				key: 'example.local',
				value: 'local',
			},
			{
				scope: 'worktree',
				key: 'example.worktree',
				value: 'worktree',
			},
		]));
	});
});
