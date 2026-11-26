import fs from 'node:fs/promises';
import path from 'node:path';
import spawn, { SubprocessError, type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';
import { isLocalGitUrl, toPackageManagerGitUrl } from '../utils/git-url.ts';
import { getPublicationUrls } from './destination.ts';

export type PublishRemote = {
	pushUrl: string;
	hasExplicitPushUrl: boolean;
	installUrl: string;
	historyUrl: string;
	configuredName?: string;
};

// Filesystem paths resolve against the repository root; file:// URLs are absolute
const isLocalPath = (url: string) => isLocalGitUrl(url) && !url.startsWith('file://');

const pathExists = (target: string) => fs.stat(target).then(
	() => true,
	(error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') {
			throw error;
		}
		return false;
	},
);

export const getPublishRemote = async (
	repositoryPath: string,
	remote: string,
): Promise<PublishRemote> => {
	const options = { cwd: repositoryPath };
	// A remote value can be a mistyped URL with credentials, so only plain names are printed
	const isPlainName = /^[\w.-]+$/.test(remote);
	const label = isPlainName ? `Remote ${JSON.stringify(remote)}` : 'Selected remote';
	const getAll = (key: string) => spawn('git', ['config', '--null', '--get-all', key], options).then(({ stdout }) => {
		const values = stdout.split('\0').slice(0, -1);
		return values.slice(values.lastIndexOf('') + 1);
	}).catch((error: unknown) => {
		if (error instanceof SubprocessError && error.exitCode === 1) {
			return [];
		}
		throw new Error(`${label} has invalid Git remote configuration.`);
	});
	// Git rejects valueless keys, which git config --null cannot distinguish from empty values.
	const expandedPush = await spawn('git', ['remote', 'get-url', '--push', '--all', '--', remote], options).then(({ stdout }) => stdout).catch((error: unknown) => {
		if (error instanceof SubprocessError && error.exitCode === 2) {
			return undefined;
		}
		throw new Error(`${label} has invalid Git remote configuration.`);
	});
	const configuredName = expandedPush === undefined ? undefined : remote;
	// A mistyped remote name parses as a relative path, so report a missing path as a missing remote
	if (
		configuredName === undefined
		&& isLocalPath(remote)
		&& !await pathExists(path.resolve(repositoryPath, remote))
	) {
		const remoteList = await getStdout(spawn('git', ['remote'], options));
		const remotes = remoteList.split('\n').filter(Boolean);
		const subject = isPlainName ? `No Git remote named ${JSON.stringify(remote)}` : 'The selected remote is not a configured Git remote or an existing path';
		const configured = remotes.length > 0
			? `Configured remotes: ${remotes.join(', ')}.`
			: 'This repository has no configured remotes.';
		throw new Error(`${subject}. ${configured} Pass a configured remote name or a Git URL with --remote.`);
	}
	const urls = configuredName === undefined ? [remote] : await getAll(`remote.${remote}.url`);
	if (urls.length === 0) {
		throw new Error(`${label} has no fetch URL configured or remaining after an empty URL reset.`);
	}
	const fetchUrl = urls[0]!;
	const configuredPushUrls = configuredName === undefined
		? []
		: await getAll(`remote.${remote}.pushurl`);
	let rawPushUrls = configuredPushUrls.length > 0 ? configuredPushUrls : urls;
	if (expandedPush !== undefined && configuredPushUrls.length === 0 && urls.length === 1) {
		const expandedFetch = await spawn('git', ['remote', 'get-url', '--', remote], options).then(({ stdout }) => stdout).catch(() => {
			throw new Error(`${label} has invalid Git remote configuration.`);
		});
		rawPushUrls = [expandedPush === expandedFetch ? fetchUrl : expandedPush];
	}
	if (rawPushUrls.length !== 1) {
		throw new Error(`${label} has ${rawPushUrls.length} push URLs. Use one remote per destination or --remote <url>.`);
	}
	const pushUrl = rawPushUrls[0]!;
	const normalizeLocal = (url: string) => (
		isLocalPath(url) ? path.resolve(repositoryPath, url) : url
	);
	for (const url of [fetchUrl, pushUrl]) {
		toPackageManagerGitUrl(url, configuredName);
	}
	const publicationUrls = getPublicationUrls(fetchUrl, pushUrl, repositoryPath);
	return {
		pushUrl: normalizeLocal(pushUrl),
		hasExplicitPushUrl: configuredPushUrls.length > 0,
		installUrl: normalizeLocal(publicationUrls.installUrl),
		historyUrl: normalizeLocal(publicationUrls.historyUrl),
		configuredName,
	};
};

export const getGitServerCommand = (url: string, command: string) => (isLocalGitUrl(url)
	? `env -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_GLOBAL ${command}`
	: command);

export const configurePublishTransport = async ({
	gitOptions,
	publishRemote,
	fetchRemoteName,
	pushRemoteName,
}: {
	gitOptions: SpawnOptions;
	publishRemote: PublishRemote;
	fetchRemoteName: string;
	pushRemoteName: string;
}) => {
	for (const [url, key, defaultCommand] of [
		[publishRemote.historyUrl, `remote.${fetchRemoteName}.uploadpack`, 'git-upload-pack'],
		[publishRemote.pushUrl, `remote.${pushRemoteName}.uploadpack`, 'git-upload-pack'],
		[publishRemote.pushUrl, `remote.${pushRemoteName}.receivepack`, 'git-receive-pack'],
	] as const) {
		if (isLocalGitUrl(url)) {
			const command = await getStdout(spawn('git', ['config', '--get', key], gitOptions)).catch(() => defaultCommand);
			await spawn('git', ['config', key, getGitServerCommand(url, command)], gitOptions);
		}
	}
};
