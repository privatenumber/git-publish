import os from 'node:os';
import path from 'node:path';
import type { TaskInnerAPI } from 'tasuku';
import byteSize from 'byte-size';
import { blueBright, dim } from 'ansis';
import { terminalColumns } from 'terminal-columns';
import task from '../utils/task.ts';
import { createPublishRepository } from '../publish-repository/create.ts';
import { loadPublishBranches } from '../publish-repository/prepare-branch.ts';
import type { PublishRemote } from '../publish-repository/remote.ts';
import {
	formatPublicationMessage,
	preparePackagePublication,
	type PackagePreparation,
	toInstallSpecifier,
} from '../package-publication/prepare.ts';
import { pushPackagePublications, type PackagePublicationPushMode } from '../package-publication/push.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getErrorDetails, writeSubprocessErrorOutput } from '../utils/error.ts';
import { packPackage } from '../utils/pack-package.ts';
import { assertSourceUnchanged, type Source } from '../utils/git.ts';
import { formatUnpublishedFilesFieldWarning } from '../utils/unpublished-files-field.ts';
import { validatePeerRanges } from '../package-publication/validate.ts';
import type { VersionSha } from '../package-publication/version-sha.ts';
import type { WorkspacePublicationPlan } from './plan.ts';
import { createInstallGraph } from './install-graph.ts';

// These tasks write to streamPreview only on failure. The cause often comes before
// the package manager's error summary, so a short preview would hide it
const failureOutputOptions = { previewLines: Number.POSITIVE_INFINITY };

export const publishWorkspaceClosure = async ({
	plan,
	packageManager,
	repositoryPath,
	publishRemote,
	pushMode,
	source,
	versionShas,
}: {
	plan: WorkspacePublicationPlan;
	packageManager: PackageManager;
	repositoryPath: string;
	publishRemote: PublishRemote;
	pushMode: PackagePublicationPushMode;
	source: Source;
	versionShas: ReadonlyMap<string, VersionSha>;
}, signal: AbortSignal): Promise<{ plan: WorkspacePublicationPlan;
	preparations: ReadonlyMap<string, PackagePreparation>; }> => {
	const repository = await createPublishRepository({
		sourceRepositoryPath: repositoryPath,
		publishRemote,
		sourceCommitId: source.commit,
		signal,
	});
	try {
		signal.throwIfAborted();
		const branches = plan.nodes.map((node, index) => ({
			publishBranch: node.branch,
			localRef: `refs/git-publish/tips/${index}`,
		}));
		const remoteTips = await loadPublishBranches(
			repository, publishRemote, branches, pushMode, signal,
		);
		const preparations = new Map<string, PackagePreparation>();
		const pendingPreparations = new Map<string, Promise<PackagePreparation>>();
		const targetsByName = new Map(plan.nodes.map(node => [node.key, node.package]));
		const installSpecifiers = new Map(plan.nodes.map(node => [
			node.key, toInstallSpecifier(publishRemote.installUrl, node.branch),
		]));
		const versionlessFallback = packageManager === 'yarn' ? '0.0.0' : undefined;
		const processPackage = async (index: number, taskApi: TaskInnerAPI) => {
			const {
				streamPreview, setStatus, setWarning, startTime, skip,
			} = taskApi;
			const packageSignal = AbortSignal.any([signal, taskApi.signal]);
			const node = plan.nodes[index]!;
			const versionSha = versionShas.get(node.key);
			startTime();
			try {
				packageSignal.throwIfAborted();
				setStatus('Preparing isolated checkout');
				const tarball = await repository.withPackWorktree(packageSignal, async (worktreePath) => {
					setStatus('Packing package and running lifecycle scripts');
					await assertSourceUnchanged(source);
					return packPackage({
						packageManager,
						packWorktreePath: worktreePath,
						packDestinationDirectory: path.join(repository.packTemporaryDirectory, String(index)),
						cwd: node.package.dir,
						gitRootPath: repositoryPath,
						gitSubdirectory: path.relative(repositoryPath, node.package.dir),
						manifestFields: versionSha,
						signal: packageSignal,
					});
				});
				const dependencies = await Promise.allSettled(
					node.dependencies.map(edge => pendingPreparations.get(edge.target)!),
				);
				if (dependencies.some(dependency => dependency.status === 'rejected')) {
					skip();
				}
				packageSignal.throwIfAborted();
				setStatus('Preparing publication commit');
				const targets = new Map<string, { dir: string;
					version?: string;
					sourceVersion?: string; }>();
				for (const edge of node.dependencies) {
					const dependency = preparations.get(edge.target)!;
					const target = targetsByName.get(edge.target)!;
					targets.set(edge.target, {
						dir: target.dir,
						version: dependency.version ?? versionlessFallback,
						sourceVersion: target.packageJson.version ?? versionlessFallback,
					});
				}
				const preparation = await preparePackagePublication({
					packageName: node.key,
					sourceManifest: node.package.packageJson,
					packedTarball: tarball,
					importRef: `refs/git-publish/${index}`,
					parent: pushMode === 'normal' && remoteTips.has(node.branch)
						? branches[index]!.localRef
						: undefined,
					branch: node.branch,
					commitMessage: formatPublicationMessage(
						plan.kind === 'standalone' ? undefined : node.key,
						source.name,
						source.shortCommit,
					),
					dependencyEdges: node.dependencies,
					installSpecifiers,
					validationContext: {
						from: node.package.dir,
						root: plan.kind === 'workspace' ? plan.rootDirectory : repositoryPath,
						packageManager,
						targets,
					},
					peers: plan.peers.filter(peer => peer.from === node.key),
					versionSha,
					gitOptions: repository.gitOptions,
					signal: packageSignal,
				});
				preparations.set(node.key, preparation);
				if (plan.kind === 'standalone') {
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
				if (packageSignal.aborted) {
					skip();
				}
				writeSubprocessErrorOutput(streamPreview, error);
				throw error;
			}
		};
		// Heuristic: build hooks are often multi-threaded, so one pack can occupy several cores.
		// On one 12-CPU machine, throughput with pkgroll hooks was flat from 2 to 4 packs and
		// dropped from 5. The best limit depends on the workload. Up to 5 CPUs packs sequentially.
		const concurrency = Math.min(
			Math.max(1, Math.floor(os.availableParallelism() / 3)),
			plan.nodes.length,
		);
		// Start in dependency order. Release the checkout before waiting for packed versions.
		try {
			await task.group(
				createTask => plan.nodes.map((node, index) => createTask(
					node.key,
					(taskApi) => {
						const preparation = processPackage(index, taskApi);
						pendingPreparations.set(node.key, preparation);
						return preparation;
					},
					failureOutputOptions,
				)),
				{ concurrency },
			);
		} finally {
			// The group rejects on the first failure, before cancelled tasks finish.
			await Promise.allSettled(pendingPreparations.values());
		}
		signal.throwIfAborted();
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
		// A hook may have changed the source after another package's pre-pack check.
		if (plan.kind === 'workspace') {
			await assertSourceUnchanged(source);
		}
		signal.throwIfAborted();
		const effectivePreparations = effective.nodes.map(node => preparations.get(node.key)!);
		// Every branch already points at its publication commit. Skipping the push
		// saves a connection but cannot detect a concurrent update since the lookup
		if (effectivePreparations.every(preparation => preparation.reusedExistingCommit)) {
			await task(
				packageCount === 1
					? `Branch ${JSON.stringify(effective.nodes[0]!.branch)} is already up to date`
					: `All ${packageCount} branches are already up to date`,
				async ({ setStatus }) => setStatus('Skipped push'),
			);
			return {
				plan: effective,
				preparations,
			};
		}
		await task(
			`Pushing ${packageCount} ${packageCount === 1 ? 'package' : 'packages'}${packageCount === 1 ? '' : ' together'}`,
			async ({ streamPreview }) => {
				try {
					await pushPackagePublications({
						repository,
						publications: effectivePreparations.map(preparation => preparation.publication),
						mode: pushMode,
						remoteTips,
						signal,
					});
				} catch (error) {
					writeSubprocessErrorOutput(streamPreview, error);
					throw error;
				}
			},
			failureOutputOptions,
		);
		// Report a completed push even after a signal; the wrapper still sets the exit code
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
