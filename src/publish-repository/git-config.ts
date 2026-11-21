import fs from 'node:fs/promises';
import path from 'node:path';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';
import { shellQuote } from '../utils/shell-quote.ts';
import type { PublishEndpoint } from './create.ts';

type GitConfigScope = 'system' | 'global' | 'local' | 'worktree' | 'command';

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
	const localConfig = await getStdout(spawn('git', ['config', '--local', '--includes', '--null', '--list'], options));
	const worktreeConfigEnabled = await getStdout(spawn('git', ['config', '--bool', 'extensions.worktreeConfig'], options)).then(value => value === 'true', () => false);
	const [systemConfig, globalConfig, worktreeConfig] = await Promise.all([
		getStdout(spawn('git', ['config', '--system', '--includes', '--null', '--list'], options)).catch(() => ''),
		getStdout(spawn('git', ['config', '--global', '--includes', '--null', '--list'], options)).catch(() => ''),
		worktreeConfigEnabled
			? getStdout(spawn('git', ['config', '--worktree', '--includes', '--null', '--list'], options))
			: undefined,
	]);

	return [
		...parseGitConfig(systemConfig, 'system'),
		...parseGitConfig(globalConfig, 'global'),
		...parseGitConfig(localConfig, 'local'),
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

const isUrlRewrite = (key: string) => /^url\..*\.(?:push)?insteadof$/s.test(key);

const isTransportConfig = (key: string) => key !== 'core.bare'
	&& key !== 'core.worktree'
	&& key !== 'core.repositoryformatversion'
	&& !key.startsWith('extensions.')
	&& key !== 'include.path'
	&& !key.startsWith('includeif.')
	&& !key.startsWith('remote.')
	&& !isUrlRewrite(key);

export const getCommandGitConfig = async (options: SpawnOptions): Promise<GitConfigEntry[]> => {
	if (!process.env.GIT_CONFIG_COUNT && !process.env.GIT_CONFIG_PARAMETERS) {
		return [];
	}
	// Read both command-scope environment formats in Git's own precedence order.
	const { stdout } = await spawn('git', ['config', '--includes', '--null', '--show-scope', '--list'], options);
	const fields = stdout.split('\0');
	const entries: GitConfigEntry[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		if (fields[index] !== 'command') {
			continue;
		}
		const entry = fields[index + 1]!;
		const separator = entry.indexOf('\n');
		entries.push({
			scope: 'command',
			key: separator === -1 ? entry : entry.slice(0, separator),
			value: separator === -1 ? '' : entry.slice(separator + 1),
		});
	}
	return entries;
};

export const getTransportConfigParameters = (commandConfig: GitConfigEntry[]) => commandConfig
	.filter(({ key }) => isTransportConfig(key))
	.map(({ key, value }) => `${shellQuote(key)}=${shellQuote(value)}`)
	.join(' ') || undefined;

export const materializePublishGitConfig = async ({
	sourceRepositoryOptions,
	destinationRepositoryPath,
	configuredName,
	endpoints,
	commandConfig,
	systemConfigPath,
	globalConfigPath,
}: {
	sourceRepositoryOptions: SpawnOptions;
	destinationRepositoryPath: string;
	configuredName: string | undefined;
	endpoints: readonly PublishEndpoint[];
	commandConfig: GitConfigEntry[];
	systemConfigPath: string;
	globalConfigPath: string;
}) => {
	const sourceConfig = await getGitConfig(sourceRepositoryOptions);
	const remoteConfigPrefix = configuredName ? `remote.${configuredName}.` : '';
	const remoteConfig = remoteConfigPrefix
		? [...sourceConfig, ...commandConfig].filter(({ key }) => key.startsWith(remoteConfigPrefix) && key !== `${remoteConfigPrefix}url` && key !== `${remoteConfigPrefix}pushurl`)
		: [];
	const publishConfig = sourceConfig.filter(({ key }) => isTransportConfig(key));
	const writes = await Promise.allSettled([
		fs.writeFile(systemConfigPath, publishConfig.filter(({ scope }) => scope === 'system').map(serializeGitConfig).join('')),
		fs.writeFile(globalConfigPath, publishConfig.filter(({ scope }) => scope === 'global').map(serializeGitConfig).join('')),
	]);
	const failedWrite = writes.find(result => result.status === 'rejected');
	if (failedWrite) {
		throw failedWrite.reason;
	}
	const configPath = await getStdout(spawn('git', ['rev-parse', '--git-path', 'config'], { cwd: destinationRepositoryPath }));
	await fs.appendFile(path.resolve(destinationRepositoryPath, configPath), [
		...publishConfig.filter(({ scope }) => scope === 'local' || scope === 'worktree'),
		...endpoints.flatMap(({ name }) => remoteConfig.map(entry => ({
			...entry,
			key: `remote.${name}.${entry.key.slice(remoteConfigPrefix.length)}`,
		}))),
	].map(serializeGitConfig).join(''));
	// Pack hooks inherit the source process's system, global, and command config.
	return sourceConfig.filter(entry => (
		(entry.scope === 'local' || entry.scope === 'worktree') && isUrlRewrite(entry.key)
	)).map(serializeGitConfig).join('');
};
