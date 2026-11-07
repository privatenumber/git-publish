import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hosted = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

const parseRepository = (value: string, directory: string) => {
	const url = URL.parse(value.replace(/^git\+/, ''));
	if (url?.protocol === 'file:') {
		return { identity: `file:${path.resolve(fileURLToPath(url))}` };
	}
	if (url?.hostname) {
		const pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
		const user = url.protocol === 'ssh:' && !hosted.has(url.hostname.toLowerCase()) ? `${url.username}@` : '';
		return {
			identity: `${user}${url.host.toLowerCase()}/${pathname.replace(/^\//, '')}`,
			host: url.hostname.toLowerCase(),
			pathname,
		};
	}
	const scp = /^(?:([^@/:]+)@)?([^/:]+):(.+)$/.exec(value);
	if (scp) {
		const host = scp[2]!.toLowerCase();
		const rawPath = scp[3]!.replace(/\/+$/, '').replace(/\.git$/, '');
		const pathname = rawPath.startsWith('/') ? rawPath : `${hosted.has(host) ? '/' : '/~/'}${rawPath}`;
		const user = hosted.has(host) ? '' : `${scp[1] ?? ''}@`;
		return {
			identity: `${user}${host}/${pathname.slice(1)}`,
			host,
			pathname,
		};
	}
	return { identity: `file:${path.resolve(directory, value)}` };
};

export const getPublicationUrls = (fetchUrl: string, pushUrls: string[], directory: string) => {
	if (pushUrls.length !== 1) {
		const fetchIdentity = parseRepository(fetchUrl, directory).identity;
		const selected = pushUrls.some(url => parseRepository(url, directory).identity === fetchIdentity)
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
	if (fetch.host && fetch.host === push.host && hosted.has(fetch.host)) {
		const suffix = /\.git\/?$/.test(fetchUrl) ? '.git' : '';
		const url = URL.parse(fetchUrl.replace(/^git\+/, ''));
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
