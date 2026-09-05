import { SubprocessError } from 'nano-spawn';
import type { TaskInnerAPI } from 'tasuku';
import { createPublishRepository } from '../publish-repository/create.ts';
import type { PublishRemote } from '../publish-repository/remote.ts';
import type { PackagePreparation } from '../package-publication/prepare.ts';
import { planPackagePublicationPush, pushPackagePublications } from '../package-publication/push.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getErrorDetails } from '../utils/error.ts';
import type { WorkspacePublicationPlan } from './plan.ts';
import { processWorkspacePackage } from './process-package.ts';

export const publishWorkspaceClosure = async ({
	plan,
	packageManager,
	repositoryPath,
	publishRemote,
	sourceName,
	sourceCommit,
	fresh,
	task,
}: {
	plan: WorkspacePublicationPlan;
	packageManager: PackageManager;
	repositoryPath: string;
	publishRemote: PublishRemote;
	sourceName: string;
	sourceCommit: string | undefined;
	fresh: boolean | undefined;
	task: TaskInnerAPI['task'];
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
		const processPackage = async (index: number, {
			streamPreview,
			setStatus,
			startTime,
		}: TaskInnerAPI) => {
			const node = plan.nodes[index]!;
			startTime();
			try {
				const preparation = await processWorkspacePackage({
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
				});
				preparations.set(node.key, preparation);
				if (preparation.reusedExistingCommit) {
					setStatus('Unchanged; reusing existing commit');
				} else {
					setStatus();
				}
				return preparation;
			} catch (error) {
				if (error instanceof SubprocessError) {
					const details = error.output || error.stderr;
					if (details) {
						streamPreview.write(details);
					}
				}
				throw error;
			}
		};
		const selectedIndex = plan.nodes.findIndex(node => node.key === plan.selected);
		if (selectedIndex > 0) {
			await task('Required workspace dependencies', async ({ task: dependencyTask }) => dependencyTask.group(
				createTask => plan.nodes.slice(0, selectedIndex).map((_, index) => createTask(
					plan.nodes[index]!.key,
					async taskApi => processPackage(index, taskApi),
				)),
			));
		}
		await task(
			plan.nodes[selectedIndex]!.key,
			async taskApi => processPackage(selectedIndex, taskApi),
		);
		const packageCount = plan.nodes.length;
		await task(
			`Pushing ${packageCount} ${packageCount === 1 ? 'package' : 'packages'}${packageCount === 1 ? '' : ' together'}`,
			async ({ streamPreview }) => {
				try {
					await pushPackagePublications({
						repository,
						publications: [...preparations.values()].map(preparation => preparation.publication),
						pushPlan,
					});
				} catch (error) {
					if (error instanceof SubprocessError) {
						const details = error.output || error.stderr;
						if (details) {
							streamPreview.write(details);
						}
					}
					throw error;
				}
			},
		);
		try {
			await repository.dispose();
		} catch (cleanupError) {
			await task('Cleaning up temporary files', async ({ setWarning }) => {
				setWarning(getErrorDetails(cleanupError));
			});
		}
		return preparations;
	} catch (error) {
		primaryError = error;
		throw error;
	} finally {
		if (primaryError) {
			await repository.dispose().catch((cleanupError: unknown) => {
				throw new AggregateError([primaryError, cleanupError], 'Failed to publish workspace packages.');
			});
		}
	}
};
