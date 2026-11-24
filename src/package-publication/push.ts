import { spawnAbortable } from '../utils/spawn-abortable.ts';
import type { PublishRepository } from '../publish-repository/create.ts';
import type { PackagePublication } from './prepare.ts';

// --fresh replaces history, so it leases each branch on the tip the lookup observed
export type PackagePublicationPushMode = 'normal' | 'lease';

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
	const args = ['push', '--no-follow-tags', ...(publications.length > 1 ? ['--atomic'] : [])];
	if (mode === 'lease') {
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
