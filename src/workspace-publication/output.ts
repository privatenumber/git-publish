import { terminalColumns } from 'terminal-columns';
import { toInstallSpecifier, type PackagePreparation } from '../package-publication/prepare.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getGitHubInstallSpecifier } from '../utils/git-url.ts';
import { shellQuote } from '../utils/shell-quote.ts';
import type { WorkspacePublicationPlan } from './plan.ts';
import { createInstallGraph } from './install-graph.ts';

export const createWorkspaceResult = (
	plan: WorkspacePublicationPlan,
	preparations: ReadonlyMap<string, PackagePreparation>,
	ref: string,
	commit: string,
	packageManager: PackageManager,
	fetchUrl: string,
) => {
	const { edges, edgesBySource, reachable } = createInstallGraph(plan);
	type Edge = (typeof edges)[number];
	const isRequired = (edge: Edge) => edge.kind === 'dependency' || edge.kind === 'peer';
	const runtimeEdges = edges.filter(edge => edge.kind === 'dependency' || edge.kind === 'optional');
	const orderedNames = plan.nodes.map(node => node.key);
	const branchSpecifiers = new Map(plan.nodes.map(({ key, branch }) => [
		key,
		getGitHubInstallSpecifier(fetchUrl, branch) ?? toInstallSpecifier(fetchUrl, branch),
	]));
	const gitPolicyNote = (hasRuntimeDependencies: boolean) => {
		if (packageManager === 'yarn') {
			return 'Yarn 4: add the repository to approvedGitRepositories in .yarnrc.yml';
		}
		if (packageManager === 'npm') {
			return `npm 12+: add --allow-git=${hasRuntimeDependencies ? 'all' : 'root'}`;
		}
		if (packageManager === 'pnpm' && hasRuntimeDependencies) {
			return 'pnpm 11+: set blockExoticSubdeps: false in pnpm-workspace.yaml';
		}
		return '';
	};
	const results = plan.roots.map((root) => {
		const required = reachable([root], isRequired);
		const all = reachable([root], () => true);
		const installed = reachable([root], edge => (
			edge.kind !== 'optionalPeer' && (edge.kind !== 'peer' || required.has(edge.from))
		));
		const requiredNames = [
			root,
			...orderedNames.filter(name => name !== root && required.has(name)),
		];
		const optional = orderedNames.filter(name => all.has(name) && !required.has(name));
		const rootTargets = new Map([[root, root]]);
		for (const edge of edges) {
			if (edge.kind === 'peer' && required.has(edge.from)) {
				rootTargets.set(edge.key, edge.target);
			}
		}
		// An argument that also occurs transitively must resolve to the manifest's exact pin.
		const runtimeTargets = new Set(
			runtimeEdges.filter(edge => all.has(edge.from)).map(edge => edge.target),
		);
		const toSpecifiers = (targets: ReadonlyMap<string, string>) => (
			[...targets].map(([name, target]) => {
				const specifier = runtimeTargets.has(target)
					? preparations.get(target)!.publication.installSpecifier
					: branchSpecifiers.get(target)!;
				return packageManager === 'yarn' || name !== target ? `${name}@${specifier}` : specifier;
			})
		);
		const command = all.size === 1 && packageManager !== 'yarn'
			? `${packageManager} i`
			: (packageManager === 'npm' ? 'npm install' : `${packageManager} add`);
		const installSpecifiers = toSpecifiers(rootTargets);
		const installCommand = `${command} ${installSpecifiers.map(shellQuote).join(' ')}`;
		const hasRuntimeDependencies = runtimeEdges.some(edge => installed.has(edge.from));
		const peers = edges.filter(edge => (
			(edge.kind === 'optionalPeer' || (edge.kind === 'peer' && !required.has(edge.from)))
				&& installed.has(edge.from) && !rootTargets.has(edge.key)
		));
		const optionalPeerTargets = new Map(peers.map(peer => [peer.key, peer.target]));
		const peerClosure = reachable(optionalPeerTargets.values(), edge => (
			edge.kind !== 'optionalPeer'
		));
		for (const name of peerClosure) {
			for (const edge of edgesBySource.get(name)!) {
				if (edge.kind === 'peer' && !rootTargets.has(edge.key)) {
					optionalPeerTargets.set(edge.key, edge.target);
				}
			}
		}
		const note = gitPolicyNote(hasRuntimeDependencies);
		const peerPolicy = gitPolicyNote(
			hasRuntimeDependencies || runtimeEdges.some(edge => peerClosure.has(edge.from)),
		);
		const optionalDependencies = optional.filter(name => installed.has(name));
		return [root, {
			installSet: {
				required: requiredNames,
				optional,
				installSpecifiers,
				installCommand,
			},
			aliases: Object.fromEntries(edges.filter(edge => (
				all.has(edge.from) && all.has(edge.target) && edge.key !== edge.target
			)).map(edge => [edge.key, edge.target])),
			notes: [
				note,
				optionalDependencies.length > 0
					? `Optional workspace dependencies ${optionalDependencies.join(', ')} install transitively`
					: '',
				peers.length > 0
					? `Optional peers ${[...new Set(peers.map(peer => peer.key))].join(', ')}: install with ${command} ${toSpecifiers(optionalPeerTargets).map(shellQuote).join(' ')}`
					: '',
				peerPolicy === note ? '' : `For optional peers: ${peerPolicy}`,
			].filter(Boolean),
		}] as const;
	});
	const installSets = Object.fromEntries(results.map(([root, result]) => (
		[root, result.installSet]
	)));
	const aliases = Object.fromEntries(results.map(([root, result]) => [root, result.aliases]));
	return {
		source: {
			ref,
			commit: commit ?? null,
		},
		packages: plan.nodes.map((node) => {
			const preparation = preparations.get(node.key)!;
			return {
				name: node.key,
				branch: node.branch,
				commit: preparation.publication.commit,
				installSpecifier: preparation.publication.installSpecifier,
				role: node.role,
				reused: preparation.reusedExistingCommit,
			};
		}),
		installSets,
		aliases,
		presentation: {
			publishAll: plan.kind === 'workspace' && plan.selection === 'default-roots',
			hasRuntimeDependencies: runtimeEdges.length > 0,
			notes: Object.fromEntries(results.map(([root, result]) => [root, result.notes])),
		},
	};
};

export type WorkspaceResult = ReturnType<typeof createWorkspaceResult>;

export const formatWorkspaceResult = (result: WorkspaceResult) => {
	const sections = [];
	const roots = Object.entries(result.installSets);
	if (result.presentation.publishAll && roots.length > 3) {
		const column = {
			width: 'content-width',
			paddingRight: 2,
		};
		const table = terminalColumns([
			['Package', 'Branch', 'Commit', 'Status', 'Role'],
			...result.packages.map(item => [item.name, item.branch, item.commit.slice(0, 7), item.reused ? 'unchanged' : 'published', item.role]),
		], {
			stdoutColumns: Number.POSITIVE_INFINITY,
			columns: [column, column, column, column, { width: 'content-width' }],
		}).replaceAll(/ +$/gm, '');
		sections.push(table);
	}
	for (const [root, set] of roots) {
		const title = roots.length === 1 && set.required.length === 1 && set.optional.length === 0 ? 'command' : root;
		sections.push([`→ Install ${title}`, set.installCommand, ...result.presentation.notes[root]!].join('\n  '));
	}
	return sections.join('\n\n');
};
