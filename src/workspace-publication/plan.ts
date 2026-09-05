import path from 'node:path';
import spawn from 'nano-spawn';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getStdout } from '../utils/get-stdout.ts';
import {
	createPublishGraph, findWorkspacePackageDirectory, type PublishGraph,
} from './graph.ts';
import { findWorkspacePackages, type Workspace } from './discover.ts';

export type WorkspacePublicationPlan = {
	workspace: Workspace;
	graph: PublishGraph;
	branches: ReadonlyMap<string, string>;
};

export const planWorkspacePublication = async ({
	cwd,
	gitRootPath,
	sourceName,
	packageManager,
	publishBranch,
}: {
	cwd: string;
	gitRootPath: string;
	sourceName: string;
	packageManager: PackageManager;
	publishBranch?: string;
}): Promise<WorkspacePublicationPlan | undefined> => {
	const workspace = await findWorkspacePackages(cwd, packageManager, gitRootPath);
	if (!workspace) {
		return undefined;
	}
	const selectedPackage = findWorkspacePackageDirectory(workspace, cwd);
	if (!selectedPackage) {
		return undefined;
	}
	const selected = selectedPackage.name;
	const graph = createPublishGraph(workspace, selected);
	const branches = new Map<string, string>();
	const branchesByName = new Set<string>();
	const selectedBranch = publishBranch ?? `npm/${sourceName}-${selected}`;
	for (const node of graph.nodes) {
		const relative = path.relative(gitRootPath, node.package.dir);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Workspace package ${JSON.stringify(node.key)} is outside the Git repository and cannot be published.`);
		}
		const branch = node.key === selected ? selectedBranch : `${selectedBranch}-${node.key}`;
		if (branchesByName.has(branch)) {
			throw new Error(`Publish branch ${JSON.stringify(branch)} is assigned to more than one workspace package.`);
		}
		try {
			await getStdout(spawn('git', ['check-ref-format', '--branch', branch]));
		} catch {
			throw new Error(`Invalid publish branch ${JSON.stringify(branch)}.`);
		}
		branchesByName.add(branch);
		branches.set(node.key, branch);
	}
	return {
		workspace,
		graph,
		branches,
	};
};
