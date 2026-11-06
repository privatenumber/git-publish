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
	const edges = new Map(plan.nodes.map(node => (
		[node.key, node.dependencies.map(edge => edge.target)]
	)));
	for (const peer of plan.peers) {
		if (peer.target) {
			edges.get(peer.from)!.push(peer.target);
		}
	}
	const installSets = Object.fromEntries(plan.roots.map((root) => {
		const visited = new Set<string>();
		const pending = [root];
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (!visited.has(current)) {
				visited.add(current);
				pending.push(...edges.get(current)!);
			}
		}
		const others = plan.nodes.map(node => node.key)
			.filter(name => name !== root && visited.has(name));
		return [root, [root, ...others]];
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
	};
};

export type WorkspaceResult = ReturnType<typeof createWorkspaceResult>;

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
		const names = result.installSets[root]!;
		const argumentsList = names.map((name) => {
			const item = packages.get(name)!;
			const specifier = names.length === 1
				? (getGitHubInstallSpecifier(fetchUrl, item.branch)
					?? toInstallSpecifier(fetchUrl, item.branch))
				: item.installSpecifier;
			return shellQuote(packageManager === 'yarn' ? `${name}@${specifier}` : specifier);
		});
		const command = names.length === 1 && packageManager !== 'yarn'
			? `${packageManager} i`
			: (packageManager === 'npm' ? 'npm install' : `${packageManager} add`);
		let notes = '';
		if (packageManager === 'yarn') {
			notes = 'Yarn 4: add the repository to approvedGitRepositories in .yarnrc.yml';
		} else if (packageManager === 'npm') {
			notes = 'npm 12+: add --allow-git=root';
		} else if (names.length > 1 && packageManager === 'pnpm') {
			notes = 'pnpm 11+: set blockExoticSubdeps: false in pnpm-workspace.yaml';
		}
		const title = plan.roots.length === 1 && names.length === 1 ? 'command' : root;
		return `→ Install ${title}\n  ${command} ${argumentsList.join(' ')}${notes ? `\n  ${notes}` : ''}`;
	}).join('\n\n');
};
