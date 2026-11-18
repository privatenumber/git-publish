import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnAbortable } from '../utils/spawn-abortable.ts';
import type { PublishRepository } from '../publish-repository/create.ts';
import { getStdout } from '../utils/get-stdout.ts';
import type { WorkspacePublicationPlan } from '../workspace-publication/plan.ts';
import type { PackagePublication } from './prepare.ts';

export type PackagePublicationPushMode = 'normal' | 'force' | 'lease';

export const planPackagePublicationPush = (
	plan: WorkspacePublicationPlan,
	fresh: boolean | undefined,
): PackagePublicationPushMode => (fresh ? (plan.kind === 'standalone' ? 'force' : 'lease') : 'normal');

const readRemoteTips = async (
	repository: PublishRepository,
	branches: Iterable<string>,
	signal: AbortSignal,
): Promise<Map<string, string>> => {
	const references = [...branches].map(branch => `refs/heads/${branch}`);
	const output = await getStdout(spawnAbortable('git', ['ls-remote', repository.pushRemoteName, ...references], {
		...repository.gitOptions,
		signal,
	}));
	const tips = new Map<string, string>();
	for (const line of output.split('\n')) {
		const separator = line.indexOf('\t');
		if (separator === -1) {
			continue;
		}
		const sha = line.slice(0, separator);
		const ref = line.slice(separator + 1);
		if (ref.startsWith('refs/heads/')) {
			tips.set(ref.slice('refs/heads/'.length), sha);
		}
	}
	return tips;
};

export const readPackagePublicationPushTips = async (
	repository: PublishRepository,
	mode: PackagePublicationPushMode,
	branches: Iterable<string>,
	signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> => (mode === 'lease' ? readRemoteTips(repository, branches, signal) : new Map());

// Resolve .. after symlinks, as Git does, rather than collapsing it with path.resolve.
const absolutePath = (directory: string, value: string) => (path.isAbsolute(value)
	? value
	: `${directory}${path.sep}${value}`);

const getCommonGitDirectory = async (
	cwd: string,
	signal: AbortSignal,
	explicitGitDirectory = false,
) => {
	const { stdout } = await spawnAbortable('git', [
		...(explicitGitDirectory ? ['--git-dir=.'] : []), 'rev-parse', '--git-common-dir',
	], {
		cwd,
		signal,
	});
	return fs.realpath(absolutePath(cwd, stdout));
};

const findDestinationGitDirectory = async (destinationPath: string, signal: AbortSignal) => {
	// Git's enter_repo strips trailing slashes and checks these suffixes in order.
	const base = destinationPath.replace(/(?<=.)\/+$/, '');
	for (const suffix of ['/.git', '', '.git/.git', '.git']) {
		const candidate = base + suffix;
		const status = await fs.stat(candidate).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
				throw error;
			}
		});
		if (!status?.isDirectory() && !status?.isFile()) {
			continue;
		}
		const { stdout } = await spawnAbortable('git', ['rev-parse', '--resolve-git-dir', candidate], { signal }).catch(() => {
			signal.throwIfAborted();
			return { stdout: '' };
		});
		// Git stops at a regular file even if it is not a valid gitfile.
		if (stdout || status.isFile()) {
			return stdout || undefined;
		}
	}
};

const assertPushDoesNotTargetSource = async (
	repository: PublishRepository,
	signal: AbortSignal,
) => {
	const { gitOptions, pushRemoteName, sourceRepositoryPath } = repository;
	const cannotVerify = () => {
		signal.throwIfAborted();
		throw new Error('Could not verify the Git push destination.');
	};
	const { stdout: url } = await spawnAbortable('git', ['remote', 'get-url', '--push', '--', pushRemoteName], {
		...gitOptions,
		signal,
	}).catch(cannotVerify);
	const colon = url.indexOf(':');
	const slash = url.indexOf('/');
	const fileUrl = url.startsWith('file://');
	if (!fileUrl && colon !== -1 && (slash === -1 || colon < slash) && !(process.platform === 'win32' && /^[a-z]:/i.test(url))) {
		return;
	}
	let destinationPath = url;
	if (fileUrl) {
		// Git and WHATWG file URLs differ on authorities and escapes. Use Git's path.
		const { stdout } = await spawnAbortable('git', ['fetch-pack', '--diag-url', url], {
			...gitOptions,
			signal,
		}).catch(cannotVerify);
		const diagnostic = stdout.slice(`Diag: url=${url}\n`.length);
		if (!diagnostic.startsWith('Diag: protocol=file\n')) {
			return;
		}
		const prefix = '\nDiag: path=';
		const start = diagnostic.indexOf(prefix);
		if (start === -1) {
			cannotVerify();
		}
		destinationPath = diagnostic.slice(start + prefix.length);
	}
	if (destinationPath.startsWith('~')) {
		// Receive-pack expands ~ using the same path interpolation as Git config.
		const { stdout } = await spawnAbortable('git', ['config', '--file', '/dev/null', '--path', '--default', destinationPath, '--get', 'git-publish.path'], { signal }).catch(cannotVerify);
		destinationPath = stdout;
	}
	const cwd = String(gitOptions.cwd);
	const gitDirectory = await findDestinationGitDirectory(
		absolutePath(cwd, destinationPath), signal,
	).catch(cannotVerify);
	if (!gitDirectory) {
		return;
	}
	const [destination, source] = await Promise.all([
		fs.realpath(gitDirectory).then(directory => getCommonGitDirectory(directory, signal, true)),
		getCommonGitDirectory(sourceRepositoryPath, signal),
	]).catch(cannotVerify);
	if (destination === source) {
		throw new Error('Refusing to push to the source repository.');
	}
};

export const pushPackagePublications = async ({
	repository,
	publications: input,
	mode,
	remoteTips,
	signal,
}: {
	repository: PublishRepository;
	publications: Iterable<PackagePublication>;
	mode: PackagePublicationPushMode;
	remoteTips: ReadonlyMap<string, string>;
	signal: AbortSignal;
}): Promise<void> => {
	const publications = [...input];
	const args = ['push', ...(publications.length > 1 ? ['--atomic'] : [])];
	if (mode === 'force') {
		args.push('--force');
	} else if (mode === 'lease') {
		for (const publication of publications) {
			args.push(`--force-with-lease=refs/heads/${publication.branch}:${remoteTips.get(publication.branch) ?? ''}`);
		}
	}
	args.push('--no-verify', repository.pushRemoteName, ...publications.map(publication => `${publication.commit}:refs/heads/${publication.branch}`));
	await assertPushDoesNotTargetSource(repository, signal);
	await spawnAbortable('git', args, {
		...repository.gitOptions,
		signal,
	});
};
