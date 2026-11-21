import { spawnAbortable } from '../utils/spawn-abortable.ts';
import type { PublishRepository } from './create.ts';

export const loadPublishBranches = async (
	repository: PublishRepository,
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
	});
	const references = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const [sha, ref] = line.split('\t');
		if (ref) {
			references.set(ref, sha!);
		}
	}
	const existingBranches = new Set<string>();
	const remoteTips = new Map<string, string>();
	const refspecs: string[] = [];
	for (const { publishBranch, localRef } of branches) {
		const tag = `refs/tags/${publishBranch}`;
		if (references.has(tag)) {
			throw new Error(`Remote tag ${JSON.stringify(tag)} conflicts with publish branch ${JSON.stringify(publishBranch)}. Package managers can resolve the tag instead of the branch.`);
		}
		const tip = references.get(`refs/heads/${publishBranch}`);
		if (tip && mode === 'lease') {
			remoteTips.set(publishBranch, tip);
		} else if (tip && mode === 'normal') {
			existingBranches.add(publishBranch);
			refspecs.push(`refs/heads/${publishBranch}:${localRef}`);
		}
	}
	if (refspecs.length > 0) {
		await spawnAbortable('git', ['fetch', '--depth=1', '--no-tags', fetchRemoteName, ...refspecs], {
			...gitOptions,
			signal,
		});
	}
	return {
		existingBranches,
		remoteTips,
	};
};
