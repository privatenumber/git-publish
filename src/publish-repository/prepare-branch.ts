import { getErrorDetails } from '../utils/error.ts';
import { redactRemote } from '../utils/git-url.ts';
import { spawnAbortable } from '../utils/spawn-abortable.ts';
import type { PublishRepository } from './create.ts';
import type { PublishRemote } from './remote.ts';

const selectorConflicts = (branch: string) => [
	`refs/${branch}`,
	`refs/tags/${branch}`,
	`refs/remotes/${branch}`,
	`refs/remotes/${branch}/HEAD`,
	// npm strips /head from refs/pull/*/head (see notes/git-publish/branch-channel.md).
	...(branch === 'pull' || branch.startsWith('pull/') ? [`refs/${branch}/head`] : []),
];

export const loadPublishBranches = async (
	repository: PublishRepository,
	remote: PublishRemote,
	branches: {
		publishBranch: string;
		localRef: string;
	}[],
	mode: 'normal' | 'force' | 'lease',
	signal: AbortSignal,
) => {
	const { gitOptions, fetchRemoteName, pushRemoteName } = repository;
	const listReferences = async (remoteName: string, url: string, kind: 'heads' | 'conflicts' | 'both') => {
		const requestedReferences = new Set(branches.flatMap(({ publishBranch }) => [
			...(kind === 'conflicts' ? [] : [`refs/heads/${publishBranch}`]),
			...(kind === 'heads' ? [] : selectorConflicts(publishBranch)),
		]));
		const { stdout } = await spawnAbortable('git', [
			'ls-remote',
			'--refs',
			remoteName,
			...requestedReferences,
		], {
			...gitOptions,
			signal,
		}).catch((error: unknown) => {
			signal.throwIfAborted();
			const remoteUrl = redactRemote(url);
			const reason = kind === 'heads' ? 'to load publish branch history' : 'to check for conflicting refs';
			throw new Error(`git-publish must list refs on ${JSON.stringify(remoteUrl)} ${reason}. Allow Git read access to this remote.\n${getErrorDetails(error)}`, { cause: error });
		});
		const references = new Map<string, string>();
		for (const line of stdout.split('\n')) {
			const [sha, ref] = line.split('\t');
			// ls-remote patterns can also match at a slash boundary inside a ref.
			if (ref && requestedReferences.has(ref)) {
				references.set(ref, sha!);
			}
		}
		return references;
	};
	const separateConflictLookup = mode === 'normal' && fetchRemoteName !== pushRemoteName;
	const references = mode === 'normal'
		? await listReferences(fetchRemoteName, remote.historyUrl, separateConflictLookup ? 'heads' : 'both')
		: await listReferences(pushRemoteName, remote.pushUrl, mode === 'lease' ? 'both' : 'conflicts');
	const pushReferences = separateConflictLookup
		? await listReferences(pushRemoteName, remote.pushUrl, 'conflicts')
		: references;
	const remoteTips = new Map<string, string>();
	const refspecs: string[] = [];
	for (const { publishBranch, localRef } of branches) {
		const conflict = selectorConflicts(publishBranch).find(ref => pushReferences.has(ref));
		if (conflict) {
			throw new Error(`Remote ref ${JSON.stringify(conflict)} conflicts with publish branch ${JSON.stringify(publishBranch)}. A package manager can resolve this ref instead of the branch.`);
		}
		const tip = references.get(`refs/heads/${publishBranch}`);
		if (tip) {
			remoteTips.set(publishBranch, tip);
			if (mode === 'normal') {
				refspecs.push(`refs/heads/${publishBranch}:${localRef}`);
			}
		}
	}
	if (refspecs.length > 0) {
		await spawnAbortable('git', ['fetch', '--depth=1', '--no-tags', fetchRemoteName, ...refspecs], {
			...gitOptions,
			signal,
		});
	}
	return remoteTips;
};
