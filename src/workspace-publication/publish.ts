import path from 'node:path';
import spawn from 'nano-spawn';
import type { TaskInnerAPI } from 'tasuku';
import byteSize from 'byte-size';
import { blueBright, dim } from 'ansis';
import { terminalColumns } from 'terminal-columns';
import task from '../utils/task.ts';
import { createPublishRepository } from '../publish-repository/create.ts';
import { loadPublishBranches } from '../publish-repository/prepare-branch.ts';
import type { PublishRemote } from '../publish-repository/remote.ts';
import { preparePackagePublication, type PackagePreparation, type PackagePublication } from '../package-publication/prepare.ts';
import { planPackagePublicationPush, pushPackagePublications } from '../package-publication/push.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getErrorDetails, writeSubprocessErrorOutput } from '../utils/error.ts';
import { packPackage } from '../utils/pack-package.ts';
import { assertSourceUnchanged, type Source } from '../utils/git.ts';
import { formatUnpublishedFilesFieldWarning } from '../utils/unpublished-files-field.ts';
import { validatePeerRanges } from '../package-publication/validate.ts';
import type { WorkspacePublicationPlan } from './plan.ts';
import { createInstallGraph } from './install-graph.ts';

export const publishWorkspaceClosure = async ({
	plan,
	packageManager,
	repositoryPath,
	publishRemote,
	source,
	fresh,
}: {
	plan: WorkspacePublicationPlan;
	packageManager: PackageManager;
	repositoryPath: string;
	publishRemote: PublishRemote;
	source: Source;
	fresh: boolean | undefined;
}): Promise<{ plan: WorkspacePublicationPlan;
	preparations: ReadonlyMap<string, PackagePreparation>; }> => {
	const repository = await createPublishRepository({
		sourceRepositoryPath: repositoryPath,
		publishRemote,
		sourceCommitId: source.commit,
	});
	try {
		const pushPlan = await planPackagePublicationPush(
			repository,
			fresh,
			plan.nodes.map(node => node.branch),
			plan.standalone,
		);
		const branches = plan.nodes.map((node, index) => ({
			publishBranch: node.branch,
			localRef: `refs/git-publish/tips/${index}`,
		}));
		const existingBranches = await loadPublishBranches(repository, branches, fresh);
		const preparations = new Map<string, PackagePreparation>();
		const processPackage = async (index: number, {
			streamPreview,
			setStatus,
			setWarning,
			startTime,
		}: TaskInnerAPI) => {
			const node = plan.nodes[index]!;
			startTime();
			try {
				setStatus('Preparing isolated checkout');
				const packWorktreeOptions = {
					cwd: repository.packWorktreePath,
					env: repository.gitOptions.env,
				};
				await spawn('git', ['-c', 'core.hooksPath=/dev/null', 'reset', '--hard', source.commit], packWorktreeOptions);
				await spawn('git', ['-c', 'core.hooksPath=/dev/null', 'clean', '-fdx'], packWorktreeOptions);
				setStatus('Packing package and running lifecycle scripts');
				await assertSourceUnchanged(source);
				const tarball = await packPackage(
					packageManager,
					repository.packWorktreePath,
					path.join(repository.packTemporaryDirectory, String(index)),
					node.package.dir,
					repositoryPath,
					path.relative(repositoryPath, node.package.dir),
				);
				setStatus('Preparing publication commit');
				const dependencyPublications = new Map<string, PackagePublication>();
				for (const edge of node.dependencies) {
					dependencyPublications.set(edge.target, preparations.get(edge.target)!.publication);
				}
				const preparation = await preparePackagePublication({
					packageName: node.key,
					sourceManifest: node.package.packageJson,
					packedTarball: tarball,
					importRef: `refs/git-publish/${index}`,
					parent: existingBranches.has(node.branch) ? branches[index]!.localRef : undefined,
					branch: node.branch,
					fetchUrl: publishRemote.installUrl,
					commitMessage: `Published ${plan.standalone ? '' : `${JSON.stringify(node.key)} `}from ${JSON.stringify(source.name)} (${source.shortCommit})`,
					dependencyEdges: node.dependencies,
					dependencyPublications,
					peers: plan.peers.filter(peer => peer.from === node.key),
					gitOptions: repository.gitOptions,
				});
				preparations.set(node.key, preparation);
				if (plan.standalone) {
					const totalSize = preparation.files.reduce((sum, file) => sum + file.size, 0);
					console.log(terminalColumns([
						...preparation.files.slice().sort((a, b) => (
							a.file < b.file ? -1 : (a.file > b.file ? 1 : 0)
						)).map(({ file, size }) => [dim(file), dim(byteSize(size).toString())]),
						['Total size', byteSize(totalSize).toString()],
					], {
						stdoutColumns: Number.POSITIVE_INFINITY,
						columns: [
							{
								width: 'content-width',
								paddingRight: 2,
							},
							{
								width: 'content-width',
								align: 'right',
								postprocess: line => blueBright(line),
							},
						],
					}));
				}
				if (preparation.reusedExistingCommit) {
					setStatus('Unchanged; reusing existing commit');
				} else {
					setStatus();
				}
				const unpublishedFilesWarning = formatUnpublishedFilesFieldWarning(
					preparation.unpublishedFilesFieldEntries,
				);
				if (unpublishedFilesWarning) {
					setWarning(unpublishedFilesWarning);
				}
				return preparation;
			} catch (error) {
				writeSubprocessErrorOutput(streamPreview, error);
				throw error;
			}
		};
		await task('Packages', async () => task.group(
			createTask => plan.nodes.map((node, index) => createTask(
				node.key,
				async taskApi => processPackage(index, taskApi),
			)),
		));
		const packed = {
			...plan,
			nodes: plan.nodes.map(node => ({
				...node,
				dependencies: preparations.get(node.key)!.dependencies,
			})),
			peers: plan.nodes.flatMap(node => preparations.get(node.key)!.peers),
		};
		const graph = createInstallGraph(packed);
		const reachable = graph.reachable(plan.roots, () => true);
		const dependencies = graph.reachable(plan.roots, edge => (
			edge.kind === 'dependency' || edge.kind === 'optional'
		));
		const effective: WorkspacePublicationPlan = {
			...packed,
			nodes: packed.nodes.filter(node => reachable.has(node.key)).map(node => ({
				...node,
				role: plan.roots.includes(node.key) ? 'root' : (dependencies.has(node.key) ? 'dependency' : 'peer'),
			})),
			peers: packed.peers.filter(peer => reachable.has(peer.from)),
		};
		validatePeerRanges(effective, preparations);
		const packageCount = effective.nodes.length;
		await task(
			`Pushing ${packageCount} ${packageCount === 1 ? 'package' : 'packages'}${packageCount === 1 ? '' : ' together'}`,
			async ({ streamPreview }) => {
				try {
					await pushPackagePublications({
						repository,
						publications: effective.nodes.map(node => preparations.get(node.key)!.publication),
						pushPlan,
						standalone: plan.standalone,
					});
				} catch (error) {
					writeSubprocessErrorOutput(streamPreview, error);
					throw error;
				}
			},
		);
		return {
			plan: effective,
			preparations,
		};
	} finally {
		const cleanup = task('Cleaning up temporary files', async ({ setWarning }) => {
			try {
				await repository.dispose();
			} catch (error) {
				setWarning(getErrorDetails(error));
			}
		});
		await cleanup;
		if (!cleanup.warning) {
			cleanup.clear();
		}
	}
};
