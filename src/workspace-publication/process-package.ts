import path from 'node:path';
import spawn from 'nano-spawn';
import type { TaskInnerAPI } from 'tasuku';
import {
	preparePackagePublication, type PackagePreparation, type PackagePublication,
} from '../package-publication/prepare.ts';
import { preparePublishBranch } from '../publish-repository/prepare-branch.ts';
import type { PublishRepository } from '../publish-repository/create.ts';
import type { PublishRemote } from '../publish-repository/remote.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { packPackage } from '../utils/pack-package.ts';
import type { WorkspacePublicationNode } from './plan.ts';

export const processWorkspacePackage = async ({
	index,
	node,
	packageManager,
	repository,
	repositoryPath,
	publishRemote,
	sourceName,
	sourceCommit,
	fresh,
	preparations,
	setStatus,
}: {
	index: number;
	node: WorkspacePublicationNode;
	packageManager: PackageManager;
	repository: PublishRepository;
	repositoryPath: string;
	publishRemote: PublishRemote;
	sourceName: string;
	sourceCommit: string | undefined;
	fresh: boolean | undefined;
	preparations: ReadonlyMap<string, PackagePreparation>;
	setStatus: TaskInnerAPI['setStatus'];
}): Promise<PackagePreparation> => {
	setStatus('Preparing isolated checkout');
	const packWorktreeOptions = {
		cwd: repository.packWorktreePath,
		env: repository.gitOptions.env,
	};
	await spawn('git', ['reset', '--hard', 'HEAD'], packWorktreeOptions);
	await spawn('git', ['clean', '-fdx'], packWorktreeOptions);
	setStatus('Packing package and running lifecycle scripts');
	const tarball = await packPackage(
		packageManager,
		repository.packWorktreePath,
		path.join(repository.packTemporaryDirectory, String(index)),
		node.package.dir,
		repositoryPath,
		path.relative(repositoryPath, node.package.dir),
	);
	setStatus('Preparing publication commit');
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
	return preparePackagePublication({
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
};
