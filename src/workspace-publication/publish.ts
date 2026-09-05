import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublishRepository, type PublishRepository } from '../publish-repository/create.ts';
import { preparePublishBranch } from '../publish-repository/prepare-branch.ts';
import type { PublishRemote } from '../publish-repository/remote.ts';
import { preparePackagePublication, type PackagePreparation } from '../package-publication/prepare.ts';
import { planPackagePublicationPush, pushPackagePublications } from '../package-publication/push.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { packPackage } from '../utils/pack-package.ts';
import type { PublishGraphNode } from './graph.ts';
import type { WorkspacePublicationPlan } from './plan.ts';
import { runDependencyGraph, type GraphNode } from './run-graph.ts';

type WorkspacePublicationTask = {
	node: PublishGraphNode;
	tarball: string;
	worktree: string;
	branch: string;
};

const prepareWorkspaceBranches = async ({
	plan,
	repository,
	fresh,
}: {
	plan: WorkspacePublicationPlan;
	repository: PublishRepository;
	fresh: boolean | undefined;
}): Promise<Map<string, string>> => {
	const worktrees = new Map<string, string>();
	plan.graph.nodes.forEach((node, index) => {
		worktrees.set(node.key, path.join(repository.temporaryDirectory, `publish-worktree-${index}`));
	});
	for (const node of plan.graph.nodes) {
		await preparePublishBranch({
			repository,
			publishBranch: plan.branches.get(node.key)!,
			localBranch: `git-publish-${randomBytes(16).toString('hex')}`,
			fresh,
			worktreePath: worktrees.get(node.key)!,
		});
	}
	return worktrees;
};

const packWorkspacePackages = async ({
	plan,
	packageManager,
	repository,
	gitRootPath,
}: {
	plan: WorkspacePublicationPlan;
	packageManager: PackageManager;
	repository: PublishRepository;
	gitRootPath: string;
}): Promise<Map<string, string>> => {
	const tarballs = new Map<string, string>();
	for (const [index, node] of plan.graph.nodes.entries()) {
		const tarball = await packPackage(
			packageManager,
			repository.packWorktreePath,
			path.join(repository.packTemporaryDirectory, String(index)),
			node.package.dir,
			gitRootPath,
			path.relative(gitRootPath, node.package.dir),
		);
		tarballs.set(node.key, tarball);
	}
	return tarballs;
};

export const publishWorkspaceClosure = async ({
	plan,
	packageManager,
	sourceRepositoryPath,
	gitRootPath,
	publishRemote,
	sourceName,
	sourceCommit,
	fresh,
}: {
	plan: WorkspacePublicationPlan;
	packageManager: PackageManager;
	sourceRepositoryPath: string;
	gitRootPath: string;
	publishRemote: PublishRemote;
	sourceName: string;
	sourceCommit: string | undefined;
	fresh: boolean | undefined;
}): Promise<ReadonlyMap<string, PackagePreparation>> => {
	const repository = await createPublishRepository({
		sourceRepositoryPath,
		publishRemote,
	});
	let primaryError: unknown;
	try {
		const pushPlan = await planPackagePublicationPush(repository, fresh);
		const worktrees = await prepareWorkspaceBranches({
			plan,
			repository,
			fresh,
		});
		const tarballs = await packWorkspacePackages({
			plan,
			packageManager,
			repository,
			gitRootPath,
		});
		const nodes: GraphNode<string, WorkspacePublicationTask>[] = plan.graph.nodes.map(node => ({
			key: node.key,
			value: {
				node,
				tarball: tarballs.get(node.key)!,
				worktree: worktrees.get(node.key)!,
				branch: plan.branches.get(node.key)!,
			},
			dependencies: node.dependencies.map(edge => edge.target),
		}));
		const preparations = await runDependencyGraph(nodes, async (
			{ key, value },
			dependencyPreparations,
		): Promise<PackagePreparation> => {
			const dependencyPublications = new Map();
			for (const [name, preparation] of dependencyPreparations) {
				dependencyPublications.set(name, preparation.publication);
			}
			return preparePackagePublication({
				packageName: key,
				packedTarball: value.tarball,
				publishWorktree: value.worktree,
				branch: value.branch,
				fetchUrl: publishRemote.fetchUrl,
				sourceName,
				sourceCommit,
				dependencyEdges: value.node.dependencies,
				dependencyPublications,
				gitOptions: repository.gitOptions,
			});
		});
		await pushPackagePublications({
			repository,
			publications: [...preparations.values()].map(preparation => preparation.publication),
			pushPlan,
		});
		return preparations;
	} catch (error) {
		primaryError = error;
		throw error;
	} finally {
		await repository.dispose().catch((cleanupError: unknown) => {
			if (primaryError) {
				throw new AggregateError([primaryError, cleanupError], 'Failed to publish workspace closure.');
			}
			throw cleanupError;
		});
	}
};
