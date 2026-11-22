import { terminalColumns } from 'terminal-columns';
import type { PackagePreparation } from '../package-publication/prepare.ts';
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
	const followUpPeers = edges.filter(edge => (
		edge.kind === 'peer' || (edge.kind === 'optionalPeer' && !edgesBySource.get(edge.from)!.some(runtime => (
			runtime.kind === 'dependency' && runtime.key === edge.key && runtime.target === edge.target
		)))
	));
	const orderedNames = plan.nodes.map(node => node.key);
	const singlePackage = plan.nodes.length === 1 && edges.length === 0 ? plan.nodes[0] : undefined;
	// Yarn expands GitHub shorthand to HTTPS, even for an SSH remote.
	const shorthand = singlePackage && !(packageManager === 'yarn' && preparations.get(singlePackage.key)!.publication.installSpecifier.startsWith('git+ssh://'))
		? getGitHubInstallSpecifier(fetchUrl, singlePackage.branch)
		: undefined;
	const getInstallArguments = (targets: ReadonlyMap<string, string>) => [...targets].map(
		([name, target]) => {
			const specifier = shorthand ?? preparations.get(target)!.publication.installSpecifier;
			return packageManager === 'yarn' || name !== target ? `${name}@${specifier}` : specifier;
		},
	);
	// A consumer's other dependencies may also be Git-published packages that the publisher
	// cannot see, so npm and pnpm always allow Git subdependencies.
	// Only npm's tarball setting depends on the packed manifests.
	const getInstallSettings = (...sets: ReadonlySet<string>[]): {
		flags: string[];
		note?: string;
	} => {
		if (packageManager === 'yarn') {
			return {
				flags: [],
				note: 'Yarn 4: add the repository to approvedGitRepositories in .yarnrc.yml',
			};
		}
		if (packageManager === 'npm') {
			const remote = sets.some(names => [...names].some(name => (
				preparations.get(name)!.remoteDependency
			)));
			return {
				flags: ['--allow-git=all', ...(remote ? ['--allow-remote=all'] : [])],
				note: `npm 12+: set allow-git=all${remote ? ' and allow-remote=all' : ''} in .npmrc to avoid ${remote ? 'EALLOWGIT and EALLOWREMOTE' : 'EALLOWGIT'} on npm ci, clean installs, and updates.`,
			};
		}
		if (packageManager === 'pnpm') {
			return {
				flags: ['--config.block-exotic-subdeps=false'],
				note: 'pnpm 11+: updates need this flag again or blockExoticSubdeps: false in pnpm-workspace.yaml; lockfile installs do not.',
			};
		}
		return { flags: [] };
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
		const command = all.size === 1 && packageManager !== 'yarn'
			? `${packageManager} i`
			: (packageManager === 'npm' ? 'npm install' : `${packageManager} add`);
		const formatCommand = (args: string[], flags: string[] = []) => [
			packageManager === 'pnpm' && flags.length > 0 ? 'pnpm add' : command,
			...flags,
			...args.map(shellQuote),
		].join(' ');
		const installSpecifiers = getInstallArguments(rootTargets);
		const settings = getInstallSettings(installed);
		const lines = [formatCommand(installSpecifiers, settings.flags)];
		if (settings.note) {
			lines.push(settings.note);
		}
		const peers = followUpPeers.filter(edge => (
			(edge.kind === 'optionalPeer' || !required.has(edge.from))
				&& installed.has(edge.from) && !rootTargets.has(edge.key)
		));
		const optionalDependencies = optional.filter(name => installed.has(name));
		if (optionalDependencies.length > 0) {
			lines.push(`Optional workspace dependencies ${optionalDependencies.join(', ')} are attempted transitively and may be skipped by the package manager.${peers.length > 0 ? ' If a required peer is missing, use the peer command below to supply it.' : ''}`);
		}
		if (peers.length > 0) {
			const optionalPeerTargets = new Map(peers.map(peer => [peer.key, peer.target]));
			const peerPolicyClosure = reachable(optionalPeerTargets.values(), edge => (
				edge.kind !== 'optionalPeer'
			));
			for (const name of reachable(optionalPeerTargets.values(), isRequired)) {
				for (const edge of edgesBySource.get(name)!) {
					if (edge.kind === 'peer' && !rootTargets.has(edge.key)) {
						optionalPeerTargets.set(edge.key, edge.target);
					}
				}
			}
			const followUp = getInstallArguments(optionalPeerTargets);
			const peerSettings = getInstallSettings(installed, peerPolicyClosure);
			const peerLabel = `Optional peers ${[...new Set(peers.map(peer => peer.key))].join(', ')}`;
			const peerCommand = formatCommand(followUp, peerSettings.flags);
			if (peerSettings.flags.length > 0) {
				lines.push(`${peerLabel}:`, peerCommand);
			} else {
				lines.push(`${peerLabel}: install with ${peerCommand}`);
			}
			if (peerSettings.note && peerSettings.note !== settings.note) {
				lines.push(peerSettings.note);
			}
		}
		return [root, {
			installSet: {
				required: requiredNames,
				optional,
				installSpecifiers,
				installCommand: formatCommand(installSpecifiers),
			},
			aliases: Object.fromEntries(edges.filter(edge => (
				all.has(edge.from) && all.has(edge.target) && edge.key !== edge.target
			)).map(edge => [edge.key, edge.target])),
			lines,
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
			installLines: Object.fromEntries(results.map(([root, result]) => [root, result.lines])),
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
		sections.push([`→ Install ${title}`, ...result.presentation.installLines[root]!].join('\n  '));
	}
	return sections.join('\n\n');
};
