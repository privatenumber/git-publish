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
) => {
	const { edges, edgesBySource, reachable } = createInstallGraph(plan);
	const isRequired = (edge: (typeof edges)[number]) => edge.kind === 'dependency' || edge.kind === 'peer';
	const orderedNames = plan.nodes.map(node => node.key);
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
		const names = new Map(requiredNames.map(name => [name, new Set<string>()]));
		names.get(root)!.add(root);
		for (const edge of edges) {
			if (isRequired(edge) && required.has(edge.from) && required.has(edge.target)) {
				names.get(edge.target)!.add(edge.key);
			}
		}
		const peers = edges.filter(edge => (
			(edge.kind === 'optionalPeer' || (edge.kind === 'peer' && !required.has(edge.from)))
				&& installed.has(edge.from) && !installed.has(edge.target)
		));
		const peerClosure = reachable(peers.map(peer => peer.target), edge => (
			isRequired(edge) && !installed.has(edge.target)
		));
		const peerNames = new Map<string, Set<string>>();
		for (const peer of peers) {
			const entries = peerNames.get(peer.target) ?? new Set<string>();
			entries.add(peer.key);
			peerNames.set(peer.target, entries);
		}
		for (const name of peerClosure) {
			for (const edge of edgesBySource.get(name)!) {
				if (isRequired(edge) && !installed.has(edge.target)) {
					const entries = peerNames.get(edge.target) ?? new Set<string>();
					entries.add(edge.key);
					peerNames.set(edge.target, entries);
				}
			}
		}
		return [root, {
			installSet: {
				required: requiredNames,
				optional,
			},
			aliases: Object.fromEntries(edges.filter(edge => (
				all.has(edge.from) && all.has(edge.target) && edge.key !== edge.target
			)).map(edge => [edge.key, edge.target])),
			installNames: Object.fromEntries([...names].map(([name, entries]) => (
				[name, [...entries]]
			))),
			optionalInstall: {
				dependencies: optional.filter(name => installed.has(name)),
				peers: peers.map(peer => ({
					name: peer.key,
					target: peer.target,
				})),
				peerNames: Object.fromEntries([...peerNames].map(([name, entries]) => (
					[name, [...entries]]
				))),
			},
		}] as const;
	});
	const installSets = Object.fromEntries(results.map(([root, result]) => (
		[root, result.installSet]
	)));
	const aliases = Object.fromEntries(results.map(([root, result]) => [root, result.aliases]));
	const installNames = Object.fromEntries(results.map(([root, result]) => (
		[root, result.installNames]
	)));
	const optionalInstall = Object.fromEntries(results.map(([root, result]) => (
		[root, result.optionalInstall]
	)));

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
			publishAll: plan.publishAll,
			installNames,
			optionalInstall,
		},
	};
};

export type WorkspaceResult = ReturnType<typeof createWorkspaceResult>;

export const formatWorkspaceResult = (
	result: WorkspaceResult,
	packageManager: PackageManager,
	fetchUrl: string,
) => {
	if (result.presentation.publishAll && Object.keys(result.installSets).length > 3) {
		return `${terminalColumns([
			['Package', 'Branch', 'Commit', 'Status', 'Role'],
			...result.packages.map(item => [item.name, item.branch, item.commit.slice(0, 7), item.reused ? 'unchanged' : 'updated', item.role]),
		], { stdoutColumns: Number.POSITIVE_INFINITY })}\nUse --json <path> for install sets.`;
	}
	const packages = new Map(result.packages.map(item => [item.name, item]));
	const roots = Object.keys(result.installSets);
	return roots.map((root) => {
		const { required: names, optional } = result.installSets[root]!;
		const packageCount = names.length + optional.length;
		const installNames = result.presentation.installNames[root]!;
		const argumentsList = names.flatMap((name) => {
			const item = packages.get(name)!;
			const specifier = packageCount === 1
				? (getGitHubInstallSpecifier(fetchUrl, item.branch)
					?? toInstallSpecifier(fetchUrl, item.branch))
				: item.installSpecifier;
			return installNames[name]!.map(installName => shellQuote(
				packageManager === 'yarn' || installName !== name ? `${installName}@${specifier}` : specifier,
			));
		});
		const command = packageCount === 1 && packageManager !== 'yarn'
			? `${packageManager} i`
			: (packageManager === 'npm' ? 'npm install' : `${packageManager} add`);
		let notes = '';
		if (packageManager === 'yarn') {
			notes = 'Yarn 4: add the repository to approvedGitRepositories in .yarnrc.yml';
		} else if (packageManager === 'npm') {
			notes = 'npm 12+: add --allow-git=root';
		} else if (packageCount > 1 && packageManager === 'pnpm') {
			notes = 'pnpm 11+: set blockExoticSubdeps: false in pnpm-workspace.yaml';
		}
		const title = roots.length === 1 && packageCount === 1 ? 'command' : root;
		const { peers: optionalPeers, dependencies: optionalDependencies, peerNames } = (
			result.presentation.optionalInstall[root]!
		);
		const optionalNote = optionalDependencies.length > 0
			? `\n  Optional workspace dependencies ${optionalDependencies.join(', ')} install transitively (npm 12 needs --allow-git=all for them)`
			: '';
		const peerArguments = Object.entries(peerNames).flatMap(([target, aliases]) => (
			aliases.map(name => shellQuote(packageManager === 'yarn' || name !== target
				? `${name}@${packages.get(target)!.installSpecifier}`
				: packages.get(target)!.installSpecifier))
		));
		const peerNote = optionalPeers.length > 0
			? `\n  Optional peers ${optionalPeers.map(peer => peer.name).join(', ')}: install with ${command} ${peerArguments.join(' ')}`
			: '';
		return `→ Install ${title}\n  ${command} ${argumentsList.join(' ')}${notes ? `\n  ${notes}` : ''}${optionalNote}${peerNote}`;
	}).join('\n\n');
};
