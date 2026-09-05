import path from 'node:path';
import spawn from 'nano-spawn';
import { renderPackageBranch } from '../package-publication/branch.ts';
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
	sourceCommitId,
	packageManager,
	publishBranch,
}: {
	cwd: string;
	gitRootPath: string;
	sourceName: string;
	sourceCommitId: string | undefined;
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
	const branchTemplate = publishBranch ?? 'npm/[gitRef]-[package]';
	const packagesByBranch = new Map<string, string>();
	for (const node of graph.nodes) {
		const relative = path.relative(gitRootPath, node.package.dir);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Workspace package ${JSON.stringify(node.key)} is outside the Git repository and cannot be published.`);
		}
		const branch = renderPackageBranch({
			template: branchTemplate,
			gitRef: sourceName,
			gitSha: sourceCommitId,
			packageName: node.key,
		});
		try {
			await getStdout(spawn('git', ['check-ref-format', '--branch', branch]));
		} catch {
			throw new Error(`Invalid publish branch ${JSON.stringify(branch)}.`);
		}
		const otherPackage = packagesByBranch.get(branch);
		if (otherPackage) {
			throw new Error(`Workspace branch template ${JSON.stringify(branchTemplate)} renders ${JSON.stringify(branch)} for both ${JSON.stringify(otherPackage)} and ${JSON.stringify(node.key)}. Include [package] to publish each package to a unique branch.`);
		}
		packagesByBranch.set(branch, node.key);
		branches.set(node.key, branch);
	}
	return {
		workspace,
		graph,
		branches,
	};
};
