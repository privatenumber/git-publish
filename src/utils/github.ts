const githubRemotePattern = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|(?:git\+)?https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

export const getGitHubRepositoryName = (remoteUrl: string) => {
	const match = remoteUrl.match(githubRemotePattern);
	if (!match) {
		return;
	}

	const [, owner, repository] = match;
	return `${owner}/${repository}`;
};
