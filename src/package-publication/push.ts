import spawn from 'nano-spawn';
import type { PublishRepository } from '../publish-repository/create.ts';
import { getStdout } from '../utils/get-stdout.ts';
import type { PackagePublication } from './prepare.ts';

export type PackagePublicationPushPlan = {
	fresh: boolean;
	remoteTips: ReadonlyMap<string, string>;
};

export const assertAtomicPackagePublicationDestination = (pushUrls: string[]) => {
	if (pushUrls.length !== 1) {
		throw new Error(`Workspace publication requires exactly one push URL, but the selected remote has ${pushUrls.length}.`);
	}
};

const readRemoteTips = async (repository: PublishRepository): Promise<Map<string, string>> => {
	const output = await getStdout(spawn('git', ['ls-remote', repository.fetchRemoteName], repository.gitOptions));
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

export const planPackagePublicationPush = async (
	repository: PublishRepository,
	fresh: boolean | undefined,
): Promise<PackagePublicationPushPlan> => ({
	fresh: Boolean(fresh),
	remoteTips: fresh ? await readRemoteTips(repository) : new Map(),
});

export const pushPackagePublications = async ({
	repository,
	publications: input,
	pushPlan,
}: {
	repository: PublishRepository;
	publications: Iterable<PackagePublication>;
	pushPlan: PackagePublicationPushPlan;
}): Promise<void> => {
	const [pushRemoteName] = repository.pushRemoteNames;
	const publications = [...input];
	const args = ['push', '--atomic'];
	if (pushPlan.fresh) {
		for (const publication of publications) {
			args.push(`--force-with-lease=refs/heads/${publication.branch}:${pushPlan.remoteTips.get(publication.branch) ?? ''}`);
		}
	}
	args.push('--no-verify', pushRemoteName!, ...publications.map(publication => publication.refspec));
	await spawn('git', args, repository.gitOptions);
};
