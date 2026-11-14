import type { WorkspacePublicationPlan } from './plan.ts';

type Edge = {
	from: string;
	key: string;
	target: string;
	kind: 'dependency' | 'optional' | 'peer' | 'optionalPeer';
};

export const createInstallGraph = (plan: Pick<WorkspacePublicationPlan, 'nodes' | 'peers'>) => {
	const edges: Edge[] = [
		...plan.nodes.flatMap(node => node.dependencies.map(edge => ({
			from: node.key,
			key: edge.key,
			target: edge.target,
			kind: edge.field === 'dependencies' ? 'dependency' as const : 'optional' as const,
		}))),
		...plan.peers.flatMap(peer => (peer.target
			? [{
				from: peer.from,
				key: peer.key,
				target: peer.target,
				kind: peer.optional ? 'optionalPeer' as const : 'peer' as const,
			}]
			: [])),
	];
	const edgesBySource = new Map(plan.nodes.map(node => [node.key, [] as Edge[]]));
	for (const edge of edges) {
		edgesBySource.get(edge.from)!.push(edge);
	}
	const reachable = (starts: Iterable<string>, follows: (edge: Edge) => boolean) => {
		const visited = new Set<string>();
		const pending = [...starts];
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (visited.has(current)) {
				continue;
			}
			visited.add(current);
			for (const edge of edgesBySource.get(current)!) {
				if (follows(edge)) {
					pending.push(edge.target);
				}
			}
		}
		return visited;
	};
	return {
		edges,
		edgesBySource,
		reachable,
	};
};
