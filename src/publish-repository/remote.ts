import path from 'node:path';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';
import { isLocalGitUrl, toPackageManagerGitUrl } from '../utils/git-url.ts';
import { getPublicationUrls } from './destination.ts';

export type PublishRemote = {
	pushUrls: string[];
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
	let configuredName: string | undefined = remote;
	const urlOutput = await getStdout(spawn('git', ['config', '--get-all', `remote.${remote}.url`], options)).catch(() => {
		configuredName = undefined;
		if (usesDefaultRemote) {
			throw new Error(`Git remote ${JSON.stringify(remote)} does not exist`);
		}

		return remote;
	});
	const urls = urlOutput.split('\n');
	const fetchUrl = urls[0]!;
	const pushUrlOutput = configuredName
		? await getStdout(spawn('git', ['config', '--get-all', `remote.${remote}.pushurl`], options)).catch(async () => {
			if (urls.length > 1) {
				return urlOutput;
			}
			const [expandedFetch, expandedPush] = await Promise.all([
				getStdout(spawn('git', ['remote', 'get-url', remote], options)),
				getStdout(spawn('git', ['remote', 'get-url', '--push', remote], options)),
			]);
			return expandedPush === expandedFetch ? fetchUrl : expandedPush;
		})
		: fetchUrl;
	const normalizeLocal = (url: string) => (isLocalGitUrl(url) && !url.startsWith('file://')
		? path.resolve(repositoryPath, url)
		: url);
	const rawPushUrls = pushUrlOutput.split('\n');
	for (const url of [fetchUrl, ...rawPushUrls]) {
		toPackageManagerGitUrl(url, configuredName);
	}
	const publicationUrls = getPublicationUrls(fetchUrl, rawPushUrls, repositoryPath);
	toPackageManagerGitUrl(publicationUrls.installUrl, configuredName);
	const pushUrls = rawPushUrls.map(normalizeLocal);
	return {
		pushUrls,
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
	pushRemoteNames,
}: {
	gitOptions: SpawnOptions;
	publishRemote: PublishRemote;
	fetchRemoteName: string;
	pushRemoteNames: string[];
}) => {
	if (isLocalGitUrl(publishRemote.historyUrl)) {
		const uploadPack = await getStdout(spawn('git', ['config', '--get', `remote.${fetchRemoteName}.uploadpack`], gitOptions)).catch(() => 'git-upload-pack');
		await spawn('git', ['config', `remote.${fetchRemoteName}.uploadpack`, getGitServerCommand(publishRemote.historyUrl, uploadPack)], gitOptions);
	}
	for (const [index, pushUrl] of publishRemote.pushUrls.entries()) {
		if (!isLocalGitUrl(pushUrl)) {
			continue;
		}

		const receivePack = await getStdout(spawn('git', ['config', '--get', `remote.${pushRemoteNames[index]}.receivepack`], gitOptions)).catch(() => 'git-receive-pack');
		await spawn('git', ['config', `remote.${pushRemoteNames[index]}.receivepack`, getGitServerCommand(pushUrl, receivePack)], gitOptions);
	}
};
