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
	const { stdout } = await spawnAbortable('git', [
		'ls-remote',
		'--refs',
		...(mode === 'force' ? ['--tags'] : []),
		mode === 'lease' ? pushRemoteName : fetchRemoteName,
		...branches.flatMap(({ publishBranch }) => (mode === 'force'
			? [`refs/tags/${publishBranch}`]
			: [`refs/heads/${publishBranch}`, `refs/tags/${publishBranch}`])),
	], {
		...gitOptions,
		signal,
	}).catch((error: unknown) => {
		signal.throwIfAborted();
		const remoteUrl = redactRemote(mode === 'lease' ? remote.pushUrl : remote.historyUrl);
		throw new Error(`git-publish must list refs on ${JSON.stringify(remoteUrl)} to check for tags with publish branch names. Allow Git read access to this remote.\n${getErrorDetails(error)}`, { cause: error });
	});
	const references = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const [sha, ref] = line.split('\t');
		if (ref) {
			references.set(ref, sha!);
		}
	}
	const remoteTips = new Map<string, string>();
	const refspecs: string[] = [];
	for (const { publishBranch, localRef } of branches) {
		const tag = `refs/tags/${publishBranch}`;
		if (references.has(tag)) {
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
