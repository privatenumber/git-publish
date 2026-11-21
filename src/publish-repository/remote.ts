import { randomUUID } from 'node:crypto';
import path from 'node:path';
import spawn, { SubprocessError, type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';
import { isLocalGitUrl, parseRepository, toPackageManagerGitUrl } from '../utils/git-url.ts';
import { getPublicationUrls } from './destination.ts';

export type PublishRemote = {
	pushUrl: string;
	installUrl: string;
	historyUrl: string;
	sameHistoryRepository: boolean;
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
	const invalidConfig = () => new Error(`${label} has invalid Git remote configuration.`);
	const expandedPush = await spawn('git', ['remote', 'get-url', '--push', '--', remote], options).then(({ stdout }) => stdout).catch((error: unknown) => {
		if (error instanceof SubprocessError && error.exitCode === 2) {
			if (usesDefaultRemote) {
				throw new Error(`Git remote ${JSON.stringify(remote)} does not exist`);
			}
			return undefined;
		}
		throw invalidConfig();
	});
	const configuredName = expandedPush === undefined ? undefined : remote;
	const urls = configuredName === undefined ? [remote] : await getAll(`remote.${remote}.url`);
	if (urls.length === 0) {
		throw new Error(`${label} has no fetch URL configured or remaining after an empty URL reset.`);
	}
	const configuredPushUrls = configuredName === undefined
		? []
		: await getAll(`remote.${remote}.pushurl`);
	const rawPushUrls = configuredPushUrls.length > 0 ? configuredPushUrls : urls;
	if (rawPushUrls.length !== 1) {
		throw new Error(`${label} has ${rawPushUrls.length} push URLs. Use one remote per destination or --remote <url>.`);
	}
	const safeName = configuredName && /^[\w.-]+$/.test(configuredName) ? configuredName : undefined;
	const validateUrl = (url: string) => {
		toPackageManagerGitUrl(url, safeName);
		if (!url || /[\r\n]/.test(url)) {
			throw invalidConfig();
		}
	};
	const rawEndpoints = new Set([urls[0]!, rawPushUrls[0]!]);
	for (const url of rawEndpoints) {
		validateUrl(url);
	}
	const resolveUrl = (arguments_: string[]) => spawn('git', arguments_, options).then(({ stdout }) => stdout).catch(() => {
		throw invalidConfig();
	});
	const resolveFetchUrl = (url: string) => resolveUrl(['ls-remote', '--get-url', '--', url]);
	const resolveLiteralEndpoints = async () => {
		// remote -v includes command-scoped remotes, which remote get-url does not.
		const temporaryName = `git-publish-${randomUUID()}`;
		const output = await resolveUrl(['-c', `remote.${temporaryName}.url=${remote}`, 'remote', '-v']);
		const prefix = `${temporaryName}\t`;
		const endpoints = output.split('\n').filter(line => line.startsWith(prefix));
		const [fetch, push] = endpoints;
		if (endpoints.length !== 2 || !fetch?.endsWith(' (fetch)') || !push?.endsWith(' (push)')) {
			throw invalidConfig();
		}
		return [fetch.slice(prefix.length, -' (fetch)'.length), push.slice(prefix.length, -' (push)'.length)] as const;
	};
	const [fetchUrl, pushUrl] = expandedPush === undefined
		? await resolveLiteralEndpoints()
		: [await resolveUrl(['remote', 'get-url', '--', remote]), expandedPush];
	const normalizeLocal = (url: string) => (isLocalGitUrl(url) && !url.startsWith('file://')
		? path.resolve(repositoryPath, url)
		: url);
	for (const url of [fetchUrl, pushUrl]) {
		if (!rawEndpoints.has(url)) {
			validateUrl(url);
		}
	}
	const publicationUrls = getPublicationUrls(fetchUrl, pushUrl, repositoryPath);
	const identity = (url: string) => parseRepository(url, repositoryPath).identity;
	const candidate = publicationUrls.installUrl;
	const usesSynthesizedUrl = candidate !== fetchUrl && candidate !== pushUrl;
	const installUrl = usesSynthesizedUrl
		&& identity(await resolveFetchUrl(candidate)) !== identity(pushUrl)
		? pushUrl
		: candidate;
	return {
		pushUrl: normalizeLocal(pushUrl),
		installUrl: normalizeLocal(installUrl),
		historyUrl: normalizeLocal(publicationUrls.historyUrl),
		sameHistoryRepository: identity(publicationUrls.historyUrl) === identity(pushUrl),
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
		const uploadPack = await getStdout(spawn('git', ['config', '--get', `remote.${pushRemoteName}.uploadpack`], gitOptions)).catch(() => 'git-upload-pack');
		await spawn('git', ['config', `remote.${pushRemoteName}.uploadpack`, getGitServerCommand(publishRemote.pushUrl, uploadPack)], gitOptions);
		const receivePack = await getStdout(spawn('git', ['config', '--get', `remote.${pushRemoteName}.receivepack`], gitOptions)).catch(() => 'git-receive-pack');
		await spawn('git', ['config', `remote.${pushRemoteName}.receivepack`, getGitServerCommand(publishRemote.pushUrl, receivePack)], gitOptions);
	}
};
