import { getErrorDetails } from '../utils/error.ts';
import { redactRemote } from '../utils/git-url.ts';
import { spawnAbortable } from '../utils/spawn-abortable.ts';
import type { PublishRepository } from './create.ts';
import type { PublishRemote } from './remote.ts';

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
	const listReferences = async (remoteName: string, url: string, kind: 'heads' | 'tags' | 'both') => {
		const { stdout } = await spawnAbortable('git', [
			'ls-remote',
			'--refs',
			remoteName,
			...branches.flatMap(({ publishBranch }) => [
				...(kind === 'tags' ? [] : [`refs/heads/${publishBranch}`]),
				...(kind === 'heads' ? [] : [`refs/tags/${publishBranch}`]),
			]),
		], {
			...gitOptions,
			signal,
		}).catch((error: unknown) => {
			signal.throwIfAborted();
			const remoteUrl = redactRemote(url);
			const reason = kind === 'heads' ? 'to load publish branch history' : 'to check for tags with publish branch names';
			throw new Error(`git-publish must list refs on ${JSON.stringify(remoteUrl)} ${reason}. Allow Git read access to this remote.\n${getErrorDetails(error)}`, { cause: error });
		});
		const references = new Map<string, string>();
		for (const line of stdout.split('\n')) {
			const [sha, ref] = line.split('\t');
			if (ref) {
				references.set(ref, sha!);
			}
		}
		return references;
	};
	const separateTagLookup = mode === 'normal' && fetchRemoteName !== pushRemoteName;
	const references = mode === 'normal'
		? await listReferences(fetchRemoteName, remote.historyUrl, separateTagLookup ? 'heads' : 'both')
		: await listReferences(pushRemoteName, remote.pushUrl, mode === 'lease' ? 'both' : 'tags');
	const tags = separateTagLookup
		? await listReferences(pushRemoteName, remote.pushUrl, 'tags')
		: references;
	const remoteTips = new Map<string, string>();
	const refspecs: string[] = [];
	for (const { publishBranch, localRef } of branches) {
		const tag = `refs/tags/${publishBranch}`;
		if (tags.has(tag)) {
			throw new Error(`Remote tag ${JSON.stringify(tag)} conflicts with publish branch ${JSON.stringify(publishBranch)}. Package managers can resolve the tag instead of the branch.`);
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
