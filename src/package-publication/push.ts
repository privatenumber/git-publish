import { spawnAbortable } from '../utils/spawn-abortable.ts';
import type { PublishRepository } from '../publish-repository/create.ts';
import type { WorkspacePublicationPlan } from '../workspace-publication/plan.ts';
import type { PackagePublication } from './prepare.ts';

export type PackagePublicationPushMode = 'normal' | 'force' | 'lease';

export const planPackagePublicationPush = (
	plan: WorkspacePublicationPlan,
	fresh: boolean | undefined,
): PackagePublicationPushMode => (fresh ? (plan.kind === 'standalone' ? 'force' : 'lease') : 'normal');

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
