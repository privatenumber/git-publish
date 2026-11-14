import { spawnAbortable } from '../utils/spawn-abortable.ts';
import type { PublishRepository } from '../publish-repository/create.ts';
import { getStdout } from '../utils/get-stdout.ts';
import { getErrorDetails } from '../utils/error.ts';
import { redactRemote } from '../utils/git-url.ts';
import type { WorkspacePublicationPlan } from '../workspace-publication/plan.ts';
import type { PackagePublication } from './prepare.ts';

export type PackagePublicationPushStrategy = {
	mode: 'normal' | 'force' | 'lease';
	destinations: string[];
};

export const planPackagePublicationPush = (
	plan: WorkspacePublicationPlan,
	pushUrls: string[],
	fresh: boolean | undefined,
): PackagePublicationPushStrategy => {
	if (plan.nodes.length > 1 && pushUrls.length !== 1) {
		throw new Error(`Workspace publication requires exactly one push URL, but the selected remote has ${pushUrls.length}.`);
	}
	let mode: PackagePublicationPushStrategy['mode'] = 'normal';
	if (fresh) {
		mode = plan.kind === 'standalone' || pushUrls.length > 1 ? 'force' : 'lease';
	}
	return {
		mode,
		destinations: pushUrls,
	};
};

const readRemoteTips = async (
	repository: PublishRepository,
	branches: Iterable<string>,
	signal: AbortSignal,
): Promise<Map<string, string>> => {
	const references = [...branches].map(branch => `refs/heads/${branch}`);
	const output = await getStdout(spawnAbortable('git', ['ls-remote', repository.pushRemoteNames[0]!, ...references], {
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
	strategy: PackagePublicationPushStrategy,
	branches: Iterable<string>,
	signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> => (strategy.mode === 'lease' ? readRemoteTips(repository, branches, signal) : new Map());

export const pushPackagePublications = async ({
	repository,
	publications: input,
	strategy,
	remoteTips,
	signal,
}: {
	repository: PublishRepository;
	publications: Iterable<PackagePublication>;
	strategy: PackagePublicationPushStrategy;
	remoteTips: ReadonlyMap<string, string>;
	signal: AbortSignal;
}): Promise<void> => {
	const [pushRemoteName] = repository.pushRemoteNames;
	const publications = [...input];
	if (strategy.destinations.length > 1) {
		for (const [index, remoteName] of repository.pushRemoteNames.entries()) {
			try {
				await spawnAbortable('git', [
					'push',
					...(strategy.mode === 'force' ? ['--force'] : []),
					'--no-verify',
					remoteName,
					`${publications[0]!.commit}:refs/heads/${publications[0]!.branch}`,
				], {
					...repository.gitOptions,
					signal,
				});
			} catch (error) {
				const outcomes = strategy.destinations.map((destination, destinationIndex) => {
					const status = destinationIndex < index ? 'succeeded' : (destinationIndex === index ? 'failed; remote outcome unknown' : 'not attempted');
					// Numbered because redaction can make credential-bearing URLs identical
					return `${destinationIndex + 1}. ${redactRemote(destination)}: ${status}`;
				});
				throw new Error(`Push destinations:\n${outcomes.join('\n')}\n${getErrorDetails(error)}`, { cause: error });
			}
		}
		return;
	}
	const args = ['push', ...(publications.length > 1 ? ['--atomic'] : [])];
	if (strategy.mode === 'force') {
		args.push('--force');
	} else if (strategy.mode === 'lease') {
		for (const publication of publications) {
			args.push(`--force-with-lease=refs/heads/${publication.branch}:${remoteTips.get(publication.branch) ?? ''}`);
		}
	}
	args.push('--no-verify', pushRemoteName!, ...publications.map(publication => `${publication.commit}:refs/heads/${publication.branch}`));
	await spawnAbortable('git', args, {
		...repository.gitOptions,
		signal,
	});
};
