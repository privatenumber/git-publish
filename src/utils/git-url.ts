import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const hostedGitHosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

type GitUrlKind = 'http' | 'https' | 'git' | 'ssh' | 'scp' | 'file' | 'local' | 'other';

const scpPath = (value: string, host: string) => (value.startsWith('/')
	? value
	: `${hostedGitHosts.has(host) ? '/' : '/~/'}${value}`);

export const parseGitUrl = (value: string) => {
	const windows = /^[a-z]:[\\/]/i.test(value);
	const drivePath = /^[a-z]:/i.test(value);
	const url = drivePath ? null : URL.parse(value.replace(/^git\+/, ''));
	const scp = !drivePath && !url?.hostname && url?.protocol !== 'file:'
		? /^(?:([^@/:]+)@)?([^/:]+):(.+)$/.exec(value)
		: null;
	const host = (url?.hostname || scp?.[2])?.toLowerCase();
	let kind: GitUrlKind = 'local';
	if (!windows && url?.protocol === 'file:') {
		kind = 'file';
	} else if (url?.hostname) {
		const protocols = {
			'http:': 'http',
			'https:': 'https',
			'git:': 'git',
			'ssh:': 'ssh',
		} as const;
		kind = protocols[url.protocol as keyof typeof protocols] ?? 'other';
	} else if (scp) {
		kind = 'scp';
	}
	const pathname = scp?.[3] ?? url?.pathname ?? value;
	return {
		value,
		url,
		kind,
		host,
		path: pathname,
		user: scp?.[1] ?? url?.username ?? '',
		password: url?.password ?? '',
		query: url?.search ?? '',
		windows,
		scpHost: scp?.[2],
	};
};

export const isLocalGitUrl = (value: string) => {
	const { kind } = parseGitUrl(value);
	return kind === 'local' || kind === 'file';
};

export const parseRepository = (value: string, directory: string) => {
	const parsed = parseGitUrl(value);
	const { url, host, kind } = parsed;
	if (kind === 'file') {
		return { identity: `file:${path.resolve(fileURLToPath(url!))}` };
	}
	if (!host) {
		return { identity: `file:${path.resolve(directory, value)}` };
	}
	const rawPath = parsed.path.replace(/\/+$/, '').replace(/\.git$/, '');
	const pathname = kind === 'scp'
		? scpPath(rawPath, host)
		: rawPath;
	const user = (kind === 'scp' || kind === 'ssh') && !hostedGitHosts.has(host)
		? `${parsed.user}@`
		: '';
	return {
		identity: `${user}${url?.host.toLowerCase() || host}/${pathname.replace(/^\//, '')}`,
		host,
		pathname,
		url,
	};
};

export const toPackageManagerGitUrl = (value: string) => {
	const parsed = parseGitUrl(value);
	const { url, kind } = parsed;
	if (url && ['ssh', 'http', 'https', 'git'].includes(kind)) {
		if (kind !== 'ssh') {
			url.username = '';
		}
		url.password = '';
		url.search = '';
		return `git+${url.href}`;
	}
	if (value.startsWith('git+')) {
		return value;
	}
	if (kind === 'file') {
		return `git+${value}`;
	}
	if (kind === 'local') {
		return `git+${pathToFileURL(parsed.windows ? value : path.resolve(value), { windows: parsed.windows }).href}`;
	}
	if (kind === 'scp') {
		const pathname = scpPath(parsed.path, parsed.scpHost!);
		return `git+ssh://${parsed.user ? `${parsed.user}@` : ''}${parsed.scpHost}${pathname}`;
	}
	return `git+${value}`;
};

const githubRepositoryName = (parsed: ReturnType<typeof parseGitUrl>) => {
	const {
		url, kind, host, user, password, query, path: pathname,
	} = parsed;
	if (host !== 'github.com' || (kind === 'scp' && parsed.scpHost !== 'github.com') || query || url?.hash || password) {
		return;
	}
	if (!((kind === 'scp' || kind === 'ssh') && user === 'git') && !(kind === 'https' && !user)) {
		return;
	}
	const match = (kind === 'scp' ? `/${pathname}` : pathname).match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
	return match ? `${match[1]}/${match[2]}` : undefined;
};

export const getGitHubRepositoryName = (value: string) => githubRepositoryName(parseGitUrl(value));

export const getGitHubInstallSpecifier = (remoteUrl: string, revision: string) => {
	const repositoryName = getGitHubRepositoryName(remoteUrl);
	return repositoryName ? `${repositoryName}#${revision}` : undefined;
};

export const isHostedGitRemote = (value: string) => {
	const parsed = parseGitUrl(value);
	const host = parsed.scpHost ?? parsed.host;
	const github = parsed.kind === 'https'
		? githubRepositoryName({
			...parsed,
			user: '',
			password: '',
		})
		: githubRepositoryName(parsed);
	return Boolean(github || host === 'gitlab.com' || host === 'bitbucket.org');
};

export const redactRemote = (value: string) => value
	.replaceAll(/(\b(?:git\+)?(?:https?|git):\/\/)[^\s/@]+@/gi, '$1[redacted]@')
	.replaceAll(/(\b(?:git\+)?[a-z][a-z\d+.-]*:\/\/)[^\s/:@]*:[^\s/@]*@/gi, '$1[redacted]@')
	.replaceAll(/(\b(?:git\+)?(?:https?|git|ssh):\/\/[^\s?]+)\?\S*/gi, '$1?[redacted]');
