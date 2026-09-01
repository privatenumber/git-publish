const githubScpRemotePattern = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
const githubRepositoryPathPattern = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
const gitUrlUsernames = new Map([
	['https:', ''],
	['ssh:', 'git'],
]);

export const getGitHubRepositoryName = (remoteUrl: string) => {
	const scpMatch = remoteUrl.match(githubScpRemotePattern);
	if (scpMatch) {
		const [, owner, repository] = scpMatch;
		return `${owner}/${repository}`;
	}

	const url = URL.parse(remoteUrl.replace(/^git\+/, ''));
	if (!url || url.hostname !== 'github.com' || url.search || url.hash || url.password) {
		return;
	}

	const expectedUsername = gitUrlUsernames.get(url.protocol);
	if (expectedUsername === undefined || url.username !== expectedUsername) {
		return;
	}

	const repositoryPathMatch = url.pathname.match(githubRepositoryPathPattern);
	if (!repositoryPathMatch) {
		return;
	}

	const [, owner, repository] = repositoryPathMatch;
	return `${owner}/${repository}`;
};
