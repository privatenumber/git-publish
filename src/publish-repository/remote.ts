import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import spawn, { SubprocessError, type Options as SpawnOptions } from 'nano-spawn';
import { isLocalGitUrl, parseGitUrl, toPackageManagerGitUrl } from '../utils/git-url.ts';
import type { PublishEndpoint } from './create.ts';
import { getPublicationUrls } from './destination.ts';

export type PublishRemote = {
	pushUrl: string;
	installUrl: string;
	historyUrl: string;
	configuredName?: string;
};

const execFileAsync = promisify(execFile);
const readGitUrl = async (args: string[], cwd: string) => {
	const { stdout } = await execFileAsync('git', args, { cwd });
	// Git adds one LF. An adjacent CR can be part of the path.
	return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
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
	const expandedPush = await readGitUrl(['remote', 'get-url', '--push', '--', remote], repositoryPath).catch((error: unknown) => {
		if (error instanceof Error && 'code' in error && error.code === 2) {
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
		readGitUrl(configuredName === undefined
			? ['ls-remote', '--get-url', '--', fetchUrl]
			: ['remote', 'get-url', '--', configuredName], repositoryPath),
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
	// Turning a filesystem alias into a file URL can invalidate its rewrite prefix.
	const installUrl = parseGitUrl(publicationUrls.installUrl).kind === 'local'
		? pushUrl
		: publicationUrls.installUrl;
	if (installUrl !== installPushUrl) {
		toPackageManagerGitUrl(installUrl, safeName);
	}
	return {
		pushUrl: normalizeLocal(pushUrl),
		installUrl: normalizeLocal(installUrl),
		historyUrl: normalizeLocal(publicationUrls.useFetchForHistory ? expandedFetch : pushUrl),
		configuredName,
	};
};

export const getGitServerCommand = (url: string, command: string) => (isLocalGitUrl(url)
	? `env -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_GLOBAL ${command}`
	: command);

export const configurePublishTransport = async ({
	gitOptions,
	endpoints,
	push,
}: {
	gitOptions: SpawnOptions;
	endpoints: readonly PublishEndpoint[];
	push: PublishEndpoint;
}) => {
	const wrapLocalCommand = async (
		{ name, url }: PublishEndpoint,
		setting: string,
		fallback: string,
	) => {
		if (!isLocalGitUrl(url)) {
			return;
		}
		const key = `remote.${name}.${setting}`;
		const { stdout } = await spawn('git', ['config', '--null', '--get-all', key], gitOptions)
			.catch(() => ({ stdout: '' }));
		// Git uses the first uploadpack or receivepack when the setting is repeated.
		const command = stdout ? stdout.split('\0', 1)[0]! : fallback;
		await spawn('git', ['config', '--replace-all', key, getGitServerCommand(url, command)], gitOptions);
	};
	for (const endpoint of endpoints) {
		await wrapLocalCommand(endpoint, 'uploadpack', 'git-upload-pack');
	}
	await wrapLocalCommand(push, 'receivepack', 'git-receive-pack');
};
