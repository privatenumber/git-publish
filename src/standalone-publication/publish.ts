import { randomBytes } from 'node:crypto';
import spawn from 'nano-spawn';
import byteSize from 'byte-size';
import { dim, lightBlue } from 'kolorist';
import task from '../utils/task.ts';
import { createPublishRepository, type PublishRepository } from '../publish-repository/create.ts';
import type { PublishRemote } from '../publish-repository/remote.ts';
import { preparePublishBranch } from '../publish-repository/prepare-branch.ts';
import { preparePackagePublication, type PackagePreparation } from '../package-publication/prepare.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getErrorDetails, writeSubprocessErrorOutput } from '../utils/error.ts';
import { packPackage } from '../utils/pack-package.ts';

const { stringify } = JSON;

export const publishStandalonePackage = async ({
	packageName,
	packageManager,
	packagePath,
	repositoryPath,
	gitSubdirectory,
	publishBranch,
	publishRemote,
	remoteName,
	sourceName,
	sourceCommit,
	fresh,
	dry,
}: {
	packageName: string;
	packageManager: PackageManager;
	packagePath: string;
	repositoryPath: string;
	gitSubdirectory: string;
	publishBranch: string;
	publishRemote: PublishRemote;
	remoteName: string;
	sourceName: string;
	sourceCommit: string | undefined;
	fresh: boolean | undefined;
	dry: boolean | undefined;
}): Promise<PackagePreparation | undefined> => {
	let repository: PublishRepository | undefined;
	let preparation: PackagePreparation | undefined;
	try {
		const createRepository = task('Creating temporary repositories', async ({ setWarning }) => {
			if (dry) {
				setWarning('');
				return;
			}
			repository = await createPublishRepository({
				sourceRepositoryPath: repositoryPath,
				publishRemote,
			});
		});
		await createRepository;
		if (!dry) {
			createRepository.clear();
		}

		const loadBranch = task('Loading publish branch', async ({ setWarning }) => {
			if (dry) {
				setWarning('');
				return;
			}
			await preparePublishBranch({
				repository: repository!,
				publishBranch,
				localBranch: `git-publish-${randomBytes(16).toString('hex')}`,
				fresh,
			});
		});
		await loadBranch;
		if (!dry) {
			loadBranch.clear();
		}

		const pack = task('Packing package', async ({ streamPreview, setWarning }) => {
			if (dry) {
				setWarning('');
				return;
			}
			try {
				return await packPackage(
					packageManager,
					repository!.packWorktreePath,
					repository!.packTemporaryDirectory,
					packagePath,
					repositoryPath,
					gitSubdirectory,
				);
			} catch (error) {
				writeSubprocessErrorOutput(streamPreview, error);
				throw error;
			}
		});
		const packedTarball = await pack;
		if (!dry) {
			pack.clear();
		}

		const prepare = task('Committing publish assets', async ({ setWarning }) => {
			if (dry) {
				setWarning('');
				return;
			}
			preparation = await preparePackagePublication({
				packageName,
				packedTarball: packedTarball!,
				publishWorktree: repository!.publishWorktreePath,
				branch: publishBranch,
				fetchUrl: publishRemote.fetchUrl,
				commitMessage: `Published from ${stringify(sourceName)}${sourceCommit ? ` (${sourceCommit})` : ''}`,
				dependencyEdges: [],
				dependencyPublications: new Map(),
				gitOptions: repository!.gitOptions,
			});
			const totalSize = preparation.files.reduce((sum, file) => sum + file.size, 0);
			console.log(lightBlue(`Publishing ${packageName}`));
			console.log(preparation.files.map(({ file, size }) => `${file} ${dim(byteSize(size).toString())}`).join('\n'));
			console.log(`\n${lightBlue('Total size')}`, byteSize(totalSize).toString());
			if (preparation.reusedExistingCommit) {
				console.warn('⚠️  No new changes found to commit.');
			}
		});
		await prepare;
		if (!dry) {
			prepare.clear();
		}

		const push = task(`Pushing branch ${stringify(publishBranch)} to remote ${stringify(remoteName)}`, async ({ setStatus, setWarning }) => {
			if (dry) {
				setWarning('');
				return;
			}
			for (const [index, pushRemoteName] of repository!.pushRemoteNames.entries()) {
				setStatus(`${index + 1} of ${repository!.pushRemoteNames.length}`);
				await spawn('git', [
					'push',
					...(fresh ? ['--force'] : []),
					'--no-verify',
					pushRemoteName,
						`HEAD:${publishBranch}`,
				], repository!.gitOptions);
			}
		});
		await push;
		if (!dry) {
			push.clear();
		}
	} finally {
		if (repository) {
			const publishRepository = repository;
			const cleanup = task('Cleaning up', async ({ setWarning }) => {
				try {
					await publishRepository.dispose();
				} catch (error) {
					setWarning(getErrorDetails(error));
				}
			});
			await cleanup;
			if (!cleanup.warning) {
				cleanup.clear();
			}
		}
	}

	return preparation;
};
