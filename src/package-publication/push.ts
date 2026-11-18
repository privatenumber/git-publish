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
	await spawnAbortable('git', args, {
		...repository.gitOptions,
		signal,
	});
};
