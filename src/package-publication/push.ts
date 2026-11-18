import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnAbortable } from '../utils/spawn-abortable.ts';
import type { PublishRepository } from '../publish-repository/create.ts';
import { getStdout } from '../utils/get-stdout.ts';
import { parseGitUrl } from '../utils/git-url.ts';
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

const assertPushDoesNotTargetSource = async (
	repository: PublishRepository,
	signal: AbortSignal,
) => {
	const { gitOptions, pushRemoteName, sourceRepositoryPath } = repository;
	const cannotVerify = () => {
		signal.throwIfAborted();
		throw new Error('Could not verify the Git push destination.');
	};
	const { stdout: url } = await spawnAbortable('git', ['remote', 'get-url', '--push', '--all', '--', pushRemoteName], {
		...gitOptions,
		signal,
	}).catch(cannotVerify);
	// A publication must have one destination; Git prints one URL per line.
	if (!url || url.includes('\n')) {
		throw new Error('Could not verify a single Git push destination.');
	}
	const { kind } = parseGitUrl(url);
	if (kind !== 'local' && kind !== 'file') {
		return;
	}
	let destinationPath = url;
	if (kind === 'file') {
		// Git and WHATWG file URLs differ on authorities and escapes. Use Git's path.
		const { stdout } = await spawnAbortable('git', ['fetch-pack', '--diag-url', url], {
			...gitOptions,
			signal,
		}).catch(cannotVerify);
		const prefix = '\nDiag: path=';
		const start = stdout.indexOf(prefix);
		if (start === -1) {
			cannotVerify();
		}
		destinationPath = stdout.slice(start + prefix.length);
	}
	const { stdout: gitDirectory } = await spawnAbortable('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
		cwd: sourceRepositoryPath,
		signal,
	}).catch(cannotVerify);
	const [destination, source, sourceGit] = await Promise.all([
		fs.realpath(path.isAbsolute(destinationPath) ? destinationPath : `${gitOptions.cwd}${path.sep}${destinationPath}`),
		fs.realpath(sourceRepositoryPath),
		fs.realpath(gitDirectory),
	]).catch(cannotVerify);
	if (destination === source || destination === sourceGit) {
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
