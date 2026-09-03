import fs from 'node:fs/promises';
import path from 'node:path';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { simpleSpawn } from '../utils/simple-spawn.ts';
import type { PublishRemote } from './remote.ts';

type GitConfigScope = 'system' | 'global' | 'local' | 'worktree';

type GitConfigEntry = {
	scope: GitConfigScope;
	key: string;
	value: string;
};

export const parseGitConfig = (config: string, scope: GitConfigScope) => config.split('\0').filter(Boolean).map((entry) => {
	const separatorIndex = entry.indexOf('\n');
	return {
		scope,
		key: entry.slice(0, separatorIndex),
		value: entry.slice(separatorIndex + 1),
	};
});

export const getGitConfig = async (options: SpawnOptions) => {
	const localConfig = await spawn('git', ['config', '--local', '--includes', '--null', '--list'], options);
	const worktreeConfigEnabled = await simpleSpawn('git', ['config', '--bool', 'extensions.worktreeConfig'], options).then(value => value === 'true').catch(() => false);
	const [systemConfig, globalConfig, worktreeConfig] = await Promise.all([
		spawn('git', ['config', '--system', '--includes', '--null', '--list'], options).then(({ stdout }) => stdout).catch(() => ''),
		spawn('git', ['config', '--global', '--includes', '--null', '--list'], options).then(({ stdout }) => stdout).catch(() => ''),
		worktreeConfigEnabled
			? spawn('git', ['config', '--worktree', '--includes', '--null', '--list'], options).then(({ stdout }) => stdout)
			: undefined,
	]);

	return [
		...parseGitConfig(systemConfig, 'system'),
		...parseGitConfig(globalConfig, 'global'),
		...parseGitConfig(localConfig.stdout, 'local'),
		...(worktreeConfig ? parseGitConfig(worktreeConfig, 'worktree') : []),
	];
};

export const serializeGitConfig = ({ key, value }: GitConfigEntry) => {
	const firstSeparatorIndex = key.indexOf('.');
	const lastSeparatorIndex = key.lastIndexOf('.');
	const section = key.slice(0, firstSeparatorIndex);
	const subsection = firstSeparatorIndex === lastSeparatorIndex
		? ''
		: ` "${key.slice(firstSeparatorIndex + 1, lastSeparatorIndex).replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
	const variable = key.slice(lastSeparatorIndex + 1);
	const escapedValue = value
		.replaceAll('\\', String.raw`\\`)
		.replaceAll('"', String.raw`\"`)
		.replaceAll('\n', String.raw`\n`)
		.replaceAll('\t', String.raw`\t`);
	return `[${section}${subsection}]\n\t${variable} = "${escapedValue}"\n`;
};

const isPublishConfig = ({ key }: GitConfigEntry) => key !== 'core.bare'
	&& key !== 'core.worktree'
	&& key !== 'core.repositoryformatversion'
	&& !key.startsWith('extensions.')
	&& key !== 'include.path'
	&& !key.startsWith('includeif.');

export const materializePublishGitConfig = async ({
	sourceRepositoryOptions,
	destinationRepositoryPath,
	remote,
	fetchRemoteName,
	pushRemoteNames,
	systemConfigPath,
	globalConfigPath,
}: {
	sourceRepositoryOptions: SpawnOptions;
	destinationRepositoryPath: string;
	remote: PublishRemote;
	fetchRemoteName: string;
	pushRemoteNames: string[];
	systemConfigPath: string;
	globalConfigPath: string;
}) => {
	const sourceConfig = await getGitConfig(sourceRepositoryOptions);
	const remoteConfigPrefix = remote.configuredName ? `remote.${remote.configuredName}.` : '';
	const remoteConfig = remoteConfigPrefix
		? sourceConfig.filter(({ key }) => key.startsWith(remoteConfigPrefix) && key !== `${remoteConfigPrefix}url` && key !== `${remoteConfigPrefix}pushurl`)
		: [];
	const publishConfig = sourceConfig.filter(({ key }) => !key.startsWith('remote.')).filter(isPublishConfig);
	await Promise.all([
		fs.writeFile(systemConfigPath, publishConfig.filter(({ scope }) => scope === 'system').map(serializeGitConfig).join('')),
		fs.writeFile(globalConfigPath, publishConfig.filter(({ scope }) => scope === 'global').map(serializeGitConfig).join('')),
	]);
	const remoteNames = [fetchRemoteName, ...pushRemoteNames];
	await fs.appendFile(path.join(destinationRepositoryPath, '.git', 'config'), [
		...publishConfig.filter(({ scope }) => scope === 'local' || scope === 'worktree'),
		...remoteNames.flatMap(remoteName => remoteConfig.map(entry => ({
			...entry,
			key: `remote.${remoteName}.${entry.key.slice(remoteConfigPrefix.length)}`,
		}))),
	].map(serializeGitConfig).join(''));
};
