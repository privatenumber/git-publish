import path from 'node:path';
import spawn from 'nano-spawn';
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
	localBranch,
	node,
	packageManager,
	repository,
	repositoryPath,
	publishRemote,
	sourceName,
	sourceCommit,
	existingBranches,
	preparations,
	setStatus,
}: {
	index: number;
	localBranch: string;
	node: WorkspacePublicationNode;
	packageManager: PackageManager;
	repository: PublishRepository;
	repositoryPath: string;
	publishRemote: PublishRemote;
	sourceName: string;
	sourceCommit: string | undefined;
	existingBranches: ReadonlySet<string>;
	preparations: ReadonlyMap<string, PackagePreparation>;
	setStatus: (status?: string) => void;
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
		localBranch,
		orphan: !existingBranches.has(node.branch),
	});
	const dependencyPublications = new Map<string, PackagePublication>();
	for (const edge of node.dependencies) {
		dependencyPublications.set(edge.target, preparations.get(edge.target)!.publication);
	}
	return preparePackagePublication({
		packageName: node.key,
		sourceManifestPath: path.join(node.package.dir, 'package.json'),
		packedTarball: tarball,
		publishWorktree: repository.publishWorktreePath,
		branch: node.branch,
		fetchUrl: publishRemote.installUrl,
		commitMessage: `Published ${JSON.stringify(node.key)} from ${JSON.stringify(sourceName)}${sourceCommit ? ` (${sourceCommit})` : ''}`,
		dependencyEdges: node.dependencies,
		dependencyPublications,
		gitOptions: repository.gitOptions,
	});
};
