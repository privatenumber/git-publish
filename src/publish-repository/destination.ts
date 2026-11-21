import { hostedGitHosts, parseRepository } from '../utils/git-url.ts';

export const getPublicationUrls = (fetchUrl: string, pushUrl: string, directory: string) => {
	const fetch = parseRepository(fetchUrl, directory);
	const push = parseRepository(pushUrl, directory);
	if (fetch.identity === push.identity) {
		return {
			installUrl: fetchUrl,
			useFetchForHistory: true,
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
		useFetchForHistory: false,
	};
};
