import path from 'node:path';
import spawn, { SubprocessError, type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';
import { isLocalGitUrl, toPackageManagerGitUrl } from '../utils/git-url.ts';
import { getPublicationUrls } from './destination.ts';

export type PublishRemote = {
	pushUrl: string;
	installUrl: string;
	historyUrl: string;
	hasPushUrl: boolean;
	configuredName?: string;
};

export const getPublishRemote = async (
	repositoryPath: string,
	remote: string,
	usesDefaultRemote: boolean,
): Promise<PublishRemote> => {
	const options = { cwd: repositoryPath };
	const label = /^[\w.-]+$/.test(remote) ? `Remote ${JSON.stringify(remote)}` : 'Selected remote';
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
			if (usesDefaultRemote) {
				throw new Error(`Git remote ${JSON.stringify(remote)} does not exist`);
			}
			return undefined;
		}
		throw new Error(`${label} has invalid Git remote configuration.`);
	});
	const configuredName = expandedPush === undefined ? undefined : remote;
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
	const normalizeLocal = (url: string) => (isLocalGitUrl(url) && !url.startsWith('file://')
		? path.resolve(repositoryPath, url)
		: url);
	const safeName = configuredName && /^[\w.-]+$/.test(configuredName) ? configuredName : undefined;
	for (const url of [fetchUrl, pushUrl]) {
		toPackageManagerGitUrl(url, safeName);
	}
	const publicationUrls = getPublicationUrls(fetchUrl, pushUrl, repositoryPath);
	return {
		pushUrl: normalizeLocal(pushUrl),
		installUrl: normalizeLocal(publicationUrls.installUrl),
		historyUrl: normalizeLocal(publicationUrls.historyUrl),
		hasPushUrl: configuredPushUrls.length > 0,
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
	for (const [name, url] of new Map([
		[fetchRemoteName, publishRemote.historyUrl],
		[pushRemoteName, publishRemote.pushUrl],
	])) {
		if (isLocalGitUrl(url)) {
			const uploadPack = await getStdout(spawn('git', ['config', '--get', `remote.${name}.uploadpack`], gitOptions)).catch(() => 'git-upload-pack');
			await spawn('git', ['config', `remote.${name}.uploadpack`, getGitServerCommand(url, uploadPack)], gitOptions);
		}
	}
	if (isLocalGitUrl(publishRemote.pushUrl)) {
		const receivePack = await getStdout(spawn('git', ['config', '--get', `remote.${pushRemoteName}.receivepack`], gitOptions)).catch(() => 'git-receive-pack');
		await spawn('git', ['config', `remote.${pushRemoteName}.receivepack`, getGitServerCommand(publishRemote.pushUrl, receivePack)], gitOptions);
	}
};
