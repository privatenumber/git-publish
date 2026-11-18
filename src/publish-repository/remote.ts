import path from 'node:path';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';
import { isLocalGitUrl, toPackageManagerGitUrl } from '../utils/git-url.ts';
import { getPublicationUrls } from './destination.ts';

export type PublishRemote = {
	pushUrl: string;
	installUrl: string;
	historyUrl: string;
	configuredName?: string;
};

export const getPublishRemote = async (
	repositoryPath: string,
	remote: string,
	usesDefaultRemote: boolean,
): Promise<PublishRemote> => {
	const options = { cwd: repositoryPath };
	const getAll = (key: string) => spawn('git', ['config', '--null', '--get-all', key], options).then(({ stdout }) => {
		const values = stdout.split('\0').slice(0, -1);
		return values.slice(values.lastIndexOf('') + 1);
	});
	let configuredName: string | undefined = remote;
	const urls = await getAll(`remote.${remote}.url`).catch(() => {
		configuredName = undefined;
		if (usesDefaultRemote) {
			throw new Error(`Git remote ${JSON.stringify(remote)} does not exist`);
		}

		return [remote];
	});
	const label = /^[\w.-]+$/.test(remote) ? `Remote ${JSON.stringify(remote)}` : 'Selected remote';
	const getRemoteUrl = (args: string[]) => spawn('git', ['remote', 'get-url', ...args, remote], options).then(({ stdout }) => stdout).catch(() => {
		throw new Error(`${label} has invalid Git remote configuration.`);
	});
	// Git rejects valueless keys, which git config --null cannot distinguish from empty values.
	const expandedPush = configuredName ? await getRemoteUrl(['--push']) : undefined;
	if (urls.length === 0) {
		throw new Error('Selected remote has no fetch URL after an empty URL reset.');
	}
	const fetchUrl = urls[0]!;
	const configuredPushUrls = configuredName
		? await getAll(`remote.${remote}.pushurl`).catch(() => [])
		: [];
	let rawPushUrls = configuredPushUrls.length > 0 ? configuredPushUrls : urls;
	if (configuredName && configuredPushUrls.length === 0 && urls.length === 1) {
		const expandedFetch = await getRemoteUrl([]);
		rawPushUrls = [expandedPush === expandedFetch ? fetchUrl : expandedPush!];
	}
	if (rawPushUrls.length !== 1) {
		throw new Error(`${label} has ${rawPushUrls.length} push URLs. Use one remote per destination or --remote <url>.`);
	}
	const pushUrl = rawPushUrls[0]!;
	const normalizeLocal = (url: string) => (isLocalGitUrl(url) && !url.startsWith('file://')
		? path.resolve(repositoryPath, url)
		: url);
	for (const url of [fetchUrl, pushUrl]) {
		toPackageManagerGitUrl(url, configuredName);
	}
	const publicationUrls = getPublicationUrls(fetchUrl, pushUrl, repositoryPath);
	return {
		pushUrl: normalizeLocal(pushUrl),
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
	if (isLocalGitUrl(publishRemote.historyUrl)) {
		const uploadPack = await getStdout(spawn('git', ['config', '--get', `remote.${fetchRemoteName}.uploadpack`], gitOptions)).catch(() => 'git-upload-pack');
		await spawn('git', ['config', `remote.${fetchRemoteName}.uploadpack`, getGitServerCommand(publishRemote.historyUrl, uploadPack)], gitOptions);
	}
	if (isLocalGitUrl(publishRemote.pushUrl)) {
		const receivePack = await getStdout(spawn('git', ['config', '--get', `remote.${pushRemoteName}.receivepack`], gitOptions)).catch(() => 'git-receive-pack');
		await spawn('git', ['config', `remote.${pushRemoteName}.receivepack`, getGitServerCommand(publishRemote.pushUrl, receivePack)], gitOptions);
	}
};
