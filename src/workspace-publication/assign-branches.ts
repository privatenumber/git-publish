import path from 'node:path';
import { renderPackageBranch, validatePublishBranch } from '../package-publication/branch.ts';
import type { PublishGraphNode } from './graph.ts';

const defaultBranchTemplate = 'npm/{gitRef}-{package}';

/**
 * Renders a publish branch for each node and rejects packages outside the Git repository
 * and templates that render the same branch for two packages.
 */
export const assignBranches = async ({
	nodes, gitRootPath, sourceName, sourceCommitId, publishBranch, publicRootName,
}: {
	nodes: PublishGraphNode[];
	gitRootPath: string;
	sourceName: string;
	sourceCommitId: string;
	publishBranch: string | undefined;
	// Without a custom template, a public workspace root publishes to the source branch name
	publicRootName: string | undefined;
}): Promise<(PublishGraphNode & { branch: string })[]> => {
	const branchTemplate = publishBranch ?? defaultBranchTemplate;
	const packagesByBranch = new Map<string, string>();
	const assigned: (PublishGraphNode & { branch: string })[] = [];
	// Sequential so the first invalid package in graph order is the one reported
	for (const node of nodes) {
		const relative = path.relative(gitRootPath, node.package.dir);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Workspace package ${JSON.stringify(node.key)} is outside the Git repository and cannot be published.`);
		}
		const branch = renderPackageBranch({
			template: node.key === publicRootName && !publishBranch ? 'npm/{gitRef}' : branchTemplate,
			gitRef: sourceName,
			gitSha: sourceCommitId,
			packageName: node.key,
		});
		await validatePublishBranch(branch);
		const otherPackage = packagesByBranch.get(branch);
		if (otherPackage) {
			throw new Error(`Workspace branch template ${JSON.stringify(branchTemplate)} renders ${JSON.stringify(branch)} for both ${JSON.stringify(otherPackage)} and ${JSON.stringify(node.key)}. Include {package} to publish each package to a unique branch.`);
		}
		packagesByBranch.set(branch, node.key);
		assigned.push({
			...node,
			branch,
		});
	}
	return assigned;
};
