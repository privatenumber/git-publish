import { terminalColumns } from 'terminal-columns';
import { toInstallSpecifier, type PackagePreparation } from '../package-publication/prepare.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getGitHubInstallSpecifier } from '../utils/github.ts';
import { shellQuote } from '../utils/shell-quote.ts';
import type { WorkspacePublicationPlan } from './plan.ts';

export const createWorkspaceResult = (
	plan: WorkspacePublicationPlan,
	preparations: ReadonlyMap<string, PackagePreparation>,
	ref: string,
	commit: string | undefined,
) => {
	const edges = new Map(plan.nodes.map(node => [node.key, node.dependencies.map(edge => ({
		target: edge.target,
		optional: edge.field === 'optionalDependencies',
	}))]));
	const packages = new Map(plan.nodes.map(node => [node.key, node.package.packageJson]));
	for (const peer of plan.peers) {
		if (peer.target) {
			edges.get(peer.from)!.push({
				target: peer.target,
				optional: packages.get(peer.from)?.peerDependenciesMeta?.[peer.key]?.optional === true,
			});
		}
	}
	const installSets = Object.fromEntries(plan.roots.map((root) => {
		const walk = (includeOptional: boolean) => {
			const visited = new Set<string>();
			const pending = [root];
			while (pending.length > 0) {
				const current = pending.pop()!;
				if (!visited.has(current)) {
					visited.add(current);
					pending.push(...edges.get(current)!
						.filter(edge => includeOptional || !edge.optional)
						.map(edge => edge.target));
				}
			}
			return visited;
		};
		const all = walk(true);
		const required = walk(false);
		const orderedNames = plan.nodes.map(node => node.key);
		return [root, {
			required: [root, ...orderedNames.filter(name => name !== root && required.has(name))],
			optional: orderedNames.filter(name => all.has(name) && !required.has(name)),
		}];
	}));
	const aliases = Object.fromEntries(plan.roots.map((root) => {
		const names = new Set([...installSets[root]!.required, ...installSets[root]!.optional]);
		const entries = plan.nodes.filter(node => names.has(node.key)).flatMap(node => (
			node.dependencies.filter(edge => edge.key !== edge.target)
				.map(edge => [edge.key, edge.target])
		));
		for (const peer of plan.peers) {
			if (names.has(peer.from) && peer.target && peer.key !== peer.target) {
				entries.push([peer.key, peer.target]);
			}
		}
		return [root, Object.fromEntries(entries)];
	}));
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
	};
};

export type WorkspaceResult = ReturnType<typeof createWorkspaceResult>;

export const formatWorkspaceAliasWarnings = (result: WorkspaceResult): string[] => {
	const aliases = new Set(Object.values(result.aliases).flatMap(entries => (
		Object.entries(entries).map(([alias, target]) => `${alias}\0${target}`)
	)));
	return [...aliases].map((entry) => {
		const [alias, target] = entry.split('\0');
		return `Warning: npm 12 needs --allow-git=all for alias ${JSON.stringify(alias)} of ${JSON.stringify(target)}.`;
	});
};

export const formatWorkspaceResult = (
	result: WorkspaceResult,
	plan: WorkspacePublicationPlan,
	packageManager: PackageManager,
	fetchUrl: string,
) => {
	if (plan.publishAll && plan.roots.length > 3) {
		return `${terminalColumns([
			['Package', 'Branch', 'Commit', 'Status', 'Role'],
			...result.packages.map(item => [item.name, item.branch, item.commit.slice(0, 7), item.reused ? 'unchanged' : 'updated', item.role]),
		], { stdoutColumns: Number.POSITIVE_INFINITY })}\nUse --json <path> for install sets.`;
	}
	const packages = new Map(result.packages.map(item => [item.name, item]));
	return plan.roots.map((root) => {
		const { required: names, optional } = result.installSets[root]!;
		const packageCount = names.length + optional.length;
		const argumentsList = names.map((name) => {
			const item = packages.get(name)!;
			const specifier = packageCount === 1
				? (getGitHubInstallSpecifier(fetchUrl, item.branch)
					?? toInstallSpecifier(fetchUrl, item.branch))
				: item.installSpecifier;
			return shellQuote(packageManager === 'yarn' ? `${name}@${specifier}` : specifier);
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
		const title = plan.roots.length === 1 && packageCount === 1 ? 'command' : root;
		const optionalNote = optional.length > 0
			? `\n  Optional workspace dependencies ${optional.join(', ')} install transitively (npm 12 needs --allow-git=all for them)`
			: '';
		return `→ Install ${title}\n  ${command} ${argumentsList.join(' ')}${notes ? `\n  ${notes}` : ''}${optionalNote}`;
	}).join('\n\n');
};
