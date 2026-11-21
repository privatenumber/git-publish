import path from 'node:path';
import spawn, { SubprocessError, type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';
import { isLocalGitUrl, toPackageManagerGitUrl } from '../utils/git-url.ts';
import { getPublicationUrls } from './destination.ts';

export type PublishRemote = {
	pushUrl: string;
	installUrl: string;
	historyUrl: string;
	configuredName?: string;
};

const getLiteralPushUrl = async (url: string, options: SpawnOptions) => {
	const { stdout } = await spawn('git', ['config', '--null', '--get-regexp', String.raw`^url\..*\.pushinsteadof$`], options).catch((error: unknown) => {
		if (error instanceof SubprocessError && error.exitCode === 1) {
			return { stdout: '' };
		}
		throw error;
	});
	// Git groups rules by base, then picks the longest matching prefix, keeping the first on ties.
	const prefixesByBase = new Map<string, string[]>();
	for (const entry of stdout.split('\0').slice(0, -1)) {
		const separator = entry.indexOf('\n');
		const base = entry.slice('url.'.length, separator - '.pushinsteadof'.length);
		const prefixes = prefixesByBase.get(base) ?? [];
		prefixes.push(entry.slice(separator + 1));
		prefixesByBase.set(base, prefixes);
	}
	let longest = -1;
	let pushUrl: string | undefined;
	for (const [base, prefixes] of prefixesByBase) {
		for (const prefix of prefixes) {
			if (prefix.length > longest && url.startsWith(prefix)) {
				longest = prefix.length;
				pushUrl = base + url.slice(longest);
			}
		}
	}
	// Git drops an empty push alias instead of using it as a destination.
	return pushUrl || undefined;
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
	const expandedPush = await spawn('git', ['remote', 'get-url', '--push', '--', remote], options).then(({ stdout }) => stdout).catch((error: unknown) => {
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
	const destinations = configuredPushUrls.length > 0 ? configuredPushUrls : urls;
	if (destinations.length !== 1) {
		throw new Error(`${label} has ${destinations.length} push URLs. Use one remote per destination or --remote <url>.`);
	}
	const safeName = configuredName && /^[\w.-]+$/.test(configuredName) ? configuredName : undefined;
	toPackageManagerGitUrl(fetchUrl, safeName);
	const [expandedFetch, literalPush] = await Promise.all([
		spawn('git', configuredName === undefined
			? ['ls-remote', '--get-url', '--', fetchUrl]
			: ['remote', 'get-url', '--', configuredName], options).then(({ stdout }) => stdout),
		configuredName === undefined ? getLiteralPushUrl(fetchUrl, options) : undefined,
	]).catch(() => {
		throw new Error(`${label} has invalid Git remote configuration.`);
	});
	const pushUrl = expandedPush ?? literalPush ?? expandedFetch;
	if (!pushUrl || !expandedFetch) {
		throw new Error(`${label} has invalid Git remote configuration.`);
	}
	// Keep consumer-facing aliases for ordinary insteadOf and explicit push URLs.
	const installPushUrl = literalPush ?? (
		expandedPush !== undefined && configuredPushUrls.length === 0 && expandedPush !== expandedFetch
			? expandedPush
			: destinations[0]!
	);
	const normalizeLocal = (url: string) => (isLocalGitUrl(url) && !url.startsWith('file://')
		? path.resolve(repositoryPath, url)
		: url);
	toPackageManagerGitUrl(installPushUrl, safeName);
	const publicationUrls = getPublicationUrls(fetchUrl, installPushUrl, repositoryPath);
	return {
		pushUrl: normalizeLocal(pushUrl),
		installUrl: normalizeLocal(publicationUrls.installUrl),
		historyUrl: normalizeLocal(publicationUrls.useFetchForHistory ? expandedFetch : pushUrl),
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
