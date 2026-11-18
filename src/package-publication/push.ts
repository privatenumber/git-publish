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

// Windows resolves drive-relative paths and collapses ..; POSIX resolves .. after symlinks.
const absolutePath = (directory: string, value: string) => {
	if (process.platform === 'win32') {
		return path.resolve(directory, value);
	}
	return path.isAbsolute(value) ? value : `${directory}${path.sep}${value}`;
};

const getCommonGitDirectory = async (
	cwd: string,
	signal: AbortSignal,
	gitArguments: string[] = [],
) => {
	const { stdout } = await spawnAbortable('git', [
		...gitArguments, 'rev-parse', '--git-common-dir',
	], {
		cwd,
		signal,
	});
	return fs.stat(absolutePath(cwd, stdout), { bigint: true });
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
		if (status.isFile()) {
			return stdout || undefined;
		}
		if (stdout) {
			return stdout;
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
	const fileUrl = url.startsWith('file://');
	// Skip non-file schemes using Git's is_url grammar, not any occurrence of ://.
	if (!fileUrl && /^[a-z\d][a-z\d+.-]*:\/\//i.test(url)) {
		return;
	}
	if (/[\r\n]/.test(url) || (fileUrl && /%0[ad]/i.test(url))) {
		cannotVerify();
	}
	const { stdout: urlDiagnostic } = await spawnAbortable('git', ['fetch-pack', '--diag-url', url], {
		...gitOptions,
		signal,
	}).catch(cannotVerify);
	const diagnostic = urlDiagnostic.slice(`Diag: url=${url}\n`.length);
	if (!diagnostic.startsWith('Diag: protocol=file\n')) {
		return;
	}
	const filePath = /^Diag: protocol=file\nDiag: hostandport=[^\r\n]*\nDiag: path=([^\r\n]+)$/.exec(diagnostic);
	let destinationPath = filePath?.[1] ?? cannotVerify();
	if (process.platform === 'win32' && fileUrl && /^\/[a-z]:/i.test(destinationPath)) {
		destinationPath = destinationPath.slice(1);
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
		fs.realpath(gitDirectory).then(directory => getCommonGitDirectory(directory, signal, ['--git-dir=.'])),
		getCommonGitDirectory(sourceRepositoryPath, signal),
	]).catch(cannotVerify);
	if (destination.dev === source.dev && destination.ino === source.ino) {
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
