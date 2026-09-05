import path from 'node:path';
import spawn from 'nano-spawn';
import { createPublishRepository } from '../publish-repository/create.ts';
import { preparePublishBranch } from '../publish-repository/prepare-branch.ts';
import type { PublishRemote } from '../publish-repository/remote.ts';
import {
	preparePackagePublication, type PackagePreparation, type PackagePublication,
} from '../package-publication/prepare.ts';
import { planPackagePublicationPush, pushPackagePublications } from '../package-publication/push.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { packPackage } from '../utils/pack-package.ts';
import type { WorkspacePublicationPlan } from './plan.ts';

export const publishWorkspaceClosure = async ({
	plan,
	packageManager,
	repositoryPath,
	publishRemote,
	sourceName,
	sourceCommit,
	fresh,
}: {
	plan: WorkspacePublicationPlan;
	packageManager: PackageManager;
	repositoryPath: string;
	publishRemote: PublishRemote;
	sourceName: string;
	sourceCommit: string | undefined;
	fresh: boolean | undefined;
}): Promise<ReadonlyMap<string, PackagePreparation>> => {
	const repository = await createPublishRepository({
		sourceRepositoryPath: repositoryPath,
		publishRemote,
	});
	let primaryError: unknown;
	try {
		const pushPlan = await planPackagePublicationPush(
			repository,
			fresh,
			plan.nodes.map(node => node.branch),
		);
		const preparations = new Map<string, PackagePreparation>();
		const packWorktreeOptions = {
			cwd: repository.packWorktreePath,
			env: repository.gitOptions.env,
		};
		for (const [index, node] of plan.nodes.entries()) {
			await spawn('git', ['reset', '--hard', 'HEAD'], packWorktreeOptions);
			await spawn('git', ['clean', '-fdx'], packWorktreeOptions);
			const tarball = await packPackage(
				packageManager,
				repository.packWorktreePath,
				path.join(repository.packTemporaryDirectory, String(index)),
				node.package.dir,
				repositoryPath,
				path.relative(repositoryPath, node.package.dir),
			);
			await preparePublishBranch({
				repository,
				publishBranch: node.branch,
				localBranch: `git-publish-${index}`,
				fresh,
			});
			const dependencyPublications = new Map<string, PackagePublication>();
			for (const edge of node.dependencies) {
				dependencyPublications.set(edge.target, preparations.get(edge.target)!.publication);
			}
			const preparation = await preparePackagePublication({
				packageName: node.key,
				packedTarball: tarball,
				publishWorktree: repository.publishWorktreePath,
				branch: node.branch,
				fetchUrl: publishRemote.fetchUrl,
				sourceName,
				sourceCommit,
				dependencyEdges: node.dependencies,
				dependencyPublications,
				gitOptions: repository.gitOptions,
			});
			preparations.set(node.key, preparation);
		}
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
