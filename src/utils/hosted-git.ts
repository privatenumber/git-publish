import { getGitHubRepositoryName } from './github.ts';

export const isHostedGitRemote = (remoteUrl: string): boolean => {
	if (getGitHubRepositoryName(remoteUrl)) {
		return true;
	}
	const url = URL.parse(remoteUrl.replace(/^git\+/, ''));
	const hostname = url?.hostname ?? /^(?:[^@/:]+@)?([^/:]+):/.exec(remoteUrl)?.[1];
	return hostname === 'gitlab.com' || hostname === 'bitbucket.org';
};
