import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from './get-stdout.ts';

export type GitConfigScope = 'system' | 'global' | 'local' | 'worktree';

export type GitConfigEntry = {
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

export const getGitConfig = async (options?: SpawnOptions) => {
	const localConfig = await spawn('git', ['config', '--local', '--includes', '--null', '--list'], options);
	const worktreeConfigEnabled = await getStdout(spawn('git', ['config', '--bool', 'extensions.worktreeConfig'], options)).then(value => value === 'true', () => false);
	const [systemConfig, globalConfig, worktreeConfig] = await Promise.all([
		spawn('git', ['config', '--system', '--includes', '--null', '--list'], options).then(({ stdout }) => stdout, () => ''),
		spawn('git', ['config', '--global', '--includes', '--null', '--list'], options).then(({ stdout }) => stdout, () => ''),
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
