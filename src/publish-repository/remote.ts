import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';

export type PublishRemote = {
	fetchUrl: string;
	pushUrls: string[];
	configuredName?: string;
};

export const getPublishRemote = async (
	repositoryPath: string,
	remote: string,
	usesDefaultRemote: boolean,
): Promise<PublishRemote> => {
	const options = { cwd: repositoryPath };
	let configuredName: string | undefined = remote;
	const fetchUrl = await getStdout(spawn('git', ['remote', 'get-url', remote], options)).catch(() => {
		configuredName = undefined;
		if (usesDefaultRemote) {
			throw new Error(`Git remote ${JSON.stringify(remote)} does not exist`);
		}

		return remote;
	});
	const pushUrlOutput = await getStdout(spawn('git', ['remote', 'get-url', '--push', '--all', remote], options)).catch(() => fetchUrl);
	return {
		fetchUrl,
		pushUrls: pushUrlOutput.split('\n'),
		configuredName,
	};
};

export const isLocalGitUrl = (url: string) => url.startsWith('file://')
	|| /^[a-z]:/i.test(url)
	|| (!/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^[^/:]+:/.test(url));

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
	if (isLocalGitUrl(publishRemote.fetchUrl)) {
		const uploadPack = await getStdout(spawn('git', ['config', '--get', `remote.${fetchRemoteName}.uploadpack`], gitOptions)).catch(() => 'git-upload-pack');
		await spawn('git', ['config', `remote.${fetchRemoteName}.uploadpack`, getGitServerCommand(publishRemote.fetchUrl, uploadPack)], gitOptions);
	}
	for (const [index, pushUrl] of publishRemote.pushUrls.entries()) {
		if (!isLocalGitUrl(pushUrl)) {
			continue;
		}

		const receivePack = await getStdout(spawn('git', ['config', '--get', `remote.${pushRemoteNames[index]}.receivepack`], gitOptions)).catch(() => 'git-receive-pack');
		await spawn('git', ['config', `remote.${pushRemoteNames[index]}.receivepack`, getGitServerCommand(pushUrl, receivePack)], gitOptions);
	}
};
