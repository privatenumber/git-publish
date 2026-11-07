import { hostedGitHosts, parseRepository } from '../utils/git-url.ts';

export const getPublicationUrls = (fetchUrl: string, pushUrls: string[], directory: string) => {
	if (pushUrls.length !== 1) {
		const fetchIdentity = parseRepository(fetchUrl, directory).identity;
		const matchesFetch = pushUrls.some(url => (
			parseRepository(url, directory).identity === fetchIdentity
		));
		const selected = matchesFetch
			? fetchUrl
			: pushUrls[0] ?? fetchUrl;
		return {
			installUrl: selected,
			historyUrl: selected,
		};
	}
	const pushUrl = pushUrls[0]!;
	const fetch = parseRepository(fetchUrl, directory);
	const push = parseRepository(pushUrl, directory);
	if (fetch.identity === push.identity) {
		return {
			installUrl: fetchUrl,
			historyUrl: fetchUrl,
		};
	}
	let installUrl = pushUrl;
	if (fetch.host && fetch.host === push.host && hostedGitHosts.has(fetch.host)) {
		const suffix = /\.git\/?$/.test(fetchUrl) ? '.git' : '';
		const { url } = fetch;
		if (url?.hostname) {
			url.pathname = `${push.pathname}${suffix}`;
			installUrl = `${fetchUrl.startsWith('git+') ? 'git+' : ''}${url.href}`;
		} else {
			installUrl = `${fetchUrl.slice(0, fetchUrl.indexOf(':') + 1)}${push.pathname!.slice(1)}${suffix}`;
		}
	}
	return {
		installUrl,
		historyUrl: pushUrl,
	};
};
