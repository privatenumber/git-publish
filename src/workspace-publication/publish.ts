import type { TaskInnerAPI } from 'tasuku';
import byteSize from 'byte-size';
import { blueBright, dim } from 'ansis';
import { terminalColumns } from 'terminal-columns';
import task from '../utils/task.ts';
import { createPublishRepository } from '../publish-repository/create.ts';
import { loadPublishBranches } from '../publish-repository/prepare-branch.ts';
import type { PublishRemote } from '../publish-repository/remote.ts';
import type { PackagePreparation } from '../package-publication/prepare.ts';
import { planPackagePublicationPush, pushPackagePublications } from '../package-publication/push.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getErrorDetails, writeSubprocessErrorOutput } from '../utils/error.ts';
import { formatUnpublishedFilesFieldWarning } from '../utils/unpublished-files-field.ts';
import type { WorkspacePublicationPlan } from './plan.ts';
import { processWorkspacePackage } from './process-package.ts';
import { satisfiesPackedPeer } from './satisfies-range.ts';

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
	try {
		const pushPlan = await planPackagePublicationPush(
			repository,
			fresh,
			plan.nodes.map(node => node.branch),
			plan.standalone,
		);
		const branches = plan.nodes.map((node, index) => ({
			publishBranch: node.branch,
			localBranch: `git-publish-${index}`,
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
				const preparation = await processWorkspacePackage({
					index,
					localBranch: branches[index]!.localBranch,
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
					standalone: plan.standalone,
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
		for (const peer of plan.peers) {
			if (!peer.target) {
				continue;
			}
			const range = preparations.get(peer.from)!.peerDependencies[peer.key];
			const { version } = preparations.get(peer.target)!;
			if (range !== undefined && /^(?:file|link):/.test(range)) {
				throw new Error(`Package ${JSON.stringify(peer.from)} declares peer ${JSON.stringify(peer.key)} as ${JSON.stringify(range)}, which consumers cannot resolve. Use a workspace: specifier or a version range.`);
			}
			if (range === undefined || !version || !satisfiesPackedPeer(range, peer.target, version)) {
				throw new Error(`Package ${JSON.stringify(peer.from)} requires peer ${JSON.stringify(peer.target)} in range ${JSON.stringify(range)}, but its packed version is ${JSON.stringify(version)}.`);
			}
		}
		const packageCount = plan.nodes.length;
		await task(
			`Pushing ${packageCount} ${packageCount === 1 ? 'package' : 'packages'}${packageCount === 1 ? '' : ' together'}`,
			async ({ streamPreview }) => {
				try {
					await pushPackagePublications({
						repository,
						publications: [...preparations.values()].map(preparation => preparation.publication),
						pushPlan,
						standalone: plan.standalone,
					});
				} catch (error) {
					writeSubprocessErrorOutput(streamPreview, error);
					throw error;
				}
			},
		);
		return preparations;
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
