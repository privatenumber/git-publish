import path from 'node:path';
import type { PackageJson } from '@npmcli/package-json';
import { renderPackageBranch, validatePublishBranch } from '../package-publication/branch.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { createPublishGraph, type PublishGraphNode, type WorkspacePeer } from './graph.ts';
import { findWorkspacePackages, type Workspace, type WorkspacePackage } from './discover.ts';
import { createInstallGraph } from './install-graph.ts';
import { selectRoots, type RootSelection } from './select-roots.ts';
import { readPlainRangesPolicy } from './link-policy.ts';
import { createCatalogResolver } from './catalogs.ts';
import { assignBranches } from './assign-branches.ts';

export type WorkspacePublicationNode = PublishGraphNode & {
	branch: string;
};

type PlanFields = {
	roots: string[];
	nodes: WorkspacePublicationNode[];
	peers: WorkspacePeer[];
};

export type WorkspacePublicationPlan = PlanFields & (
	| {
		kind: 'standalone';
	}
	| {
		kind: 'workspace';
		rootDirectory: string;
		selection: RootSelection;
	}
);

const listedPrivatePackages = 5;

export const formatSkippedPrivatePackages = (names: string[]) => {
	const listed = names.slice(0, listedPrivatePackages);
	const more = names.length - listed.length;
	const list = more > 0 ? `${listed.join(', ')}, and ${more} more` : listed.join(', ');
	return names.length === 1
		? `Skipped 1 private package: ${list}. Pass --include-private to publish it.`
		: `Skipped ${names.length} private packages: ${list}. Pass --include-private to publish them.`;
};

// A standalone package has no workspace to resolve `workspace:` specifications against
const assertNoWorkspaceDependencies = (packageJson: PackageJson) => {
	const workspaceDependencies: string[] = [];
	for (const field of ['dependencies', 'optionalDependencies'] as const) {
		for (const [name, specification] of Object.entries(packageJson[field] ?? {})) {
			if (specification?.startsWith('workspace:')) {
				workspaceDependencies.push(`- ${field}.${name}: ${specification}`);
			}
		}
	}
	if (workspaceDependencies.length > 0) {
		throw new Error(`Cannot publish packages with workspace dependencies:\n${workspaceDependencies.join('\n')}\nPre-bundle these dependencies before publishing.`);
	}
};

export const planStandalonePublication = async ({
	cwd, gitRootPath, packageJson, sourceName, sourceCommitId, publishBranch,
}: {
	cwd: string;
	gitRootPath: string;
	packageJson: PackageJson;
	sourceName: string;
	sourceCommitId: string;
	publishBranch: string | undefined;
}): Promise<WorkspacePublicationPlan> => {
	assertNoWorkspaceDependencies(packageJson);
	const { name } = packageJson;
	if (typeof name !== 'string' || !name) {
		const packageJsonPath = path.relative(gitRootPath, path.join(cwd, 'package.json'));
		throw new Error(`${packageJsonPath} has no "name". Add a package name before publishing.`);
	}
	const branch = publishBranch
		? renderPackageBranch({
			template: publishBranch,
			gitRef: sourceName,
			gitSha: sourceCommitId,
			packageName: name,
		})
		: `npm/${sourceName}${path.relative(gitRootPath, cwd) ? `-${name}` : ''}`;
	await validatePublishBranch(branch);
	return {
		kind: 'standalone',
		roots: [name],
		peers: [],
		nodes: [{
			key: name,
			package: {
				name,
				dir: cwd,
				packageJson: packageJson as WorkspacePackage['packageJson'],
			},
			dependencies: [],
			role: 'root',
			branch,
		}],
	};
};

// Each root's install set must not map one install name to two packages
const validateInstallNames = (plan: Pick<WorkspacePublicationPlan, 'roots' | 'nodes' | 'peers'>) => {
	const { edges, reachable } = createInstallGraph(plan);
	for (const root of plan.roots) {
		const members = reachable([root], () => true);
		const names = new Map([[root, root]]);
		for (const edge of edges) {
			if (!members.has(edge.from)) {
				continue;
			}
			const previous = names.get(edge.key);
			if (previous !== undefined && previous !== edge.target) {
				throw new Error(`Install name ${JSON.stringify(edge.key)} refers to both ${JSON.stringify(previous)} and ${JSON.stringify(edge.target)} in the install set for ${JSON.stringify(root)}.`);
			}
			names.set(edge.key, edge.target);
		}
	}
};

// The root package is a candidate even when the workspace globs do not list it
const listCandidates = (workspace: Workspace) => {
	const candidates = [...workspace.packages];
	if (workspace.rootPackage && !candidates.some(candidate => (
		candidate.dir === workspace.rootDirectory
	))) {
		candidates.push(workspace.rootPackage);
	}
	return candidates;
};

export const planWorkspacePublication = async ({
	cwd,
	gitRootPath,
	sourceName,
	sourceCommitId,
	packageManager,
	publishBranch,
	includePrivate,
	selection,
}: {
	cwd: string;
	gitRootPath: string;
	sourceName: string;
	sourceCommitId: string;
	packageManager: PackageManager;
	publishBranch?: string;
	includePrivate: boolean | undefined;
	selection: string[];
}): Promise<
	| (Extract<WorkspacePublicationPlan, { kind: 'workspace' }> & { skippedPrivatePackages: string[] })
	| { kind: 'standalone' }
> => {
	const workspace = await findWorkspacePackages(cwd, packageManager, gitRootPath);
	if (!workspace) {
		return { kind: 'standalone' };
	}
	const candidates = listCandidates(workspace);
	const selected = selectRoots({
		workspace,
		candidates,
		cwd,
		selection,
		includePrivate,
	});
	if (!selected) {
		return { kind: 'standalone' };
	}
	const skippedPrivatePackages = selected.skippedPrivatePackages.sort();
	if (selected.roots.size === 0) {
		throw new Error(skippedPrivatePackages.length > 0
			? `No non-private workspace packages found to publish. ${formatSkippedPrivatePackages(skippedPrivatePackages)}`
			: 'No workspace packages found to publish.');
	}
	const roots = [...selected.roots];
	const plainRanges = await readPlainRangesPolicy(packageManager, workspace.rootDirectory);
	const graph = createPublishGraph({
		...workspace,
		packages: candidates,
	}, roots, {
		policy: { plainRanges },
		resolveSpecification: await createCatalogResolver(packageManager, workspace, candidates),
	});
	const publicRoot = selected.selection === 'public-root';
	if (publicRoot && graph.nodes.length === 1 && graph.peers.length === 0) {
		return { kind: 'standalone' };
	}
	const nodes = await assignBranches({
		nodes: graph.nodes,
		gitRootPath,
		sourceName,
		sourceCommitId,
		publishBranch,
		publicRootName: publicRoot ? workspace.rootPackage!.name : undefined,
	});
	const plan = {
		kind: 'workspace' as const,
		rootDirectory: workspace.rootDirectory,
		roots,
		selection: selected.selection,
		// A skipped member that a root depends on is published anyway, so the notice omits it.
		skippedPrivatePackages: skippedPrivatePackages.filter(name => (
			!nodes.some(node => node.key === name)
		)),
		nodes,
		peers: graph.peers,
	};
	validateInstallNames(plan);
	return plan;
};
