import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { randomBytes } from 'node:crypto';
import spawn, { SubprocessError } from 'nano-spawn';
import task from 'tasuku';
import { cli } from 'cleye';
import type { PackageJson } from '@npmcli/package-json';
import byteSize from 'byte-size';
import { cyan, dim, lightBlue } from 'kolorist';
import terminalLink from 'terminal-link';
import packageMeta from '../package.json' with { type: 'json' };
import { getStdout } from './utils/get-stdout.ts';
import {
	assertCleanTree, getCurrentSourceName, getCurrentCommit,
	getCurrentCommitId,
} from './utils/git.ts';
import { readJson } from './utils/read-json.ts';
import { detectPackageManager } from './utils/detect-package-manager.ts';
import { packPackage } from './utils/pack-package.ts';
import { getGitHubInstallSpecifier, getGitHubRepositoryName } from './utils/github.ts';
import { getErrorDetails } from './utils/error.ts';
import { createPublishRepository, type PublishRepository } from './publish-repository/create.ts';
import { preparePublishBranch } from './publish-repository/prepare-branch.ts';
import { getPublishRemote } from './publish-repository/remote.ts';
import { renderPackageBranch } from './package-publication/branch.ts';
import { preparePackagePublication } from './package-publication/prepare.ts';
import { assertAtomicPackagePublicationDestination } from './package-publication/push.ts';
import { planWorkspacePublication, type WorkspacePublicationPlan } from './workspace-publication/plan.ts';
import { publishWorkspaceClosure } from './workspace-publication/publish.ts';

const { stringify } = JSON;

const formatWorkspacePublicationPlan = (
	plan: WorkspacePublicationPlan,
	sourceName: string,
): string => {
	const lines = [`Publishing packages for ${JSON.stringify(plan.selected)} from ${JSON.stringify(sourceName)}:`];
	const nodesByName = new Map(plan.nodes.map(node => [node.key, node]));
	for (const node of plan.nodes) {
		const rewrites = node.dependencies.map(edge => `${edge.key} → ${nodesByName.get(edge.target)!.branch}`).join(', ');
		lines.push(`- ${node.key} → ${node.branch}${rewrites ? ` (dependencies: ${rewrites})` : ''}`);
	}
	return lines.join('\n');
};

const formatWorkspacePeerDiagnostics = (plan: WorkspacePublicationPlan): string | undefined => {
	if (plan.peers.length === 0) {
		return undefined;
	}
	const lines = ['Internal workspace peer dependencies are not published. Consumers must provide them:'];
	for (const peer of plan.peers) {
		const target = peer.target
			? ` resolves to ${JSON.stringify(peer.target)}`
			: ' does not resolve to a workspace package';
		lines.push(`- ${JSON.stringify(peer.from)} declares ${JSON.stringify(peer.key)}: ${JSON.stringify(peer.specification)}${target}.`);
	}
	return lines.join('\n');
};

(async () => {
	let usedDefaultRemote = false;
	const argv = cli({
		name: packageMeta.name,
		version: packageMeta.version,
		strictFlags: true,
		flags: {
			branch: {
				type: String,
				alias: 'b',
				placeholder: '<branch template>',
				description: 'Branch template. Supports {gitRef}, {gitSha}, and {package}.',
			},
			remote: {
				type: String,
				alias: 'r',
				placeholder: '<remote name or Git URL>',
				description: 'The Git remote or URL to push to.',
				default: () => {
					usedDefaultRemote = true;
					return 'origin';
				},
			},
			fresh: {
				type: Boolean,
				alias: 'o',
				description: 'Publish without a commit history. Warning: Force-pushes to remote',
			},
			dry: {
				type: Boolean,
				alias: 'd',
				description: 'Dry run mode. Will not commit or push to the remote.',
			},
			force: {
				type: Boolean,
				alias: 'f',
				description: 'Skip checks and force publish.',
			},
		},
		help: {
			description: packageMeta.description,
		},
	});
	if (argv._.length > 0) {
		throw new Error('This command does not accept positional arguments.');
	}

	await assertCleanTree();

	const cwd = process.cwd();
	const gitRootPath = await getStdout(spawn('git', ['rev-parse', '--show-toplevel']));
	const sourceName = await getCurrentSourceName();
	const sourceCommit = await getCurrentCommit();
	const packageJsonPath = 'package.json';

	try {
		await fs.access(packageJsonPath);
	} catch {
		throw new Error('No package.json found in current working directory.');
	}

	const packageJson = await readJson(packageJsonPath) as PackageJson;
	if (packageJson.private && !argv.flags.force) {
		throw new Error('This package is marked as private. Use --force to publish it anyway.');
	}

	const {
		branch, remote, fresh, dry,
	} = argv.flags;
	const sourceCommitId = branch?.includes('{gitSha}')
		? await getCurrentCommitId()
		: undefined;
	const packageManager = await detectPackageManager(cwd, gitRootPath);
	const closurePlan = await planWorkspacePublication({
		cwd,
		gitRootPath,
		sourceName,
		sourceCommitId,
		packageManager,
		publishBranch: branch,
	});

	if (closurePlan) {
		const publishRemote = await getPublishRemote(gitRootPath, remote, usedDefaultRemote);
		const remoteUrl = publishRemote.fetchUrl;
		assertAtomicPackagePublicationDestination(publishRemote.pushUrls);

		if (dry) {
			console.log(formatWorkspacePublicationPlan(closurePlan, sourceName));
		}
		const peerDiagnostics = formatWorkspacePeerDiagnostics(closurePlan);
		if (peerDiagnostics) {
			console.warn(peerDiagnostics);
		}

		const workspacePublish = await task(
			`Publishing ${stringify(closurePlan.selected)} from ${stringify(sourceName)}`,
			async ({
				task: parentTask, setTitle, setStatus,
			}) => {
				if (dry) {
					setStatus('Dry run');
					return;
				}

				const preparationsByName = await publishWorkspaceClosure({
					plan: closurePlan,
					packageManager,
					repositoryPath: gitRootPath,
					publishRemote,
					sourceName,
					sourceCommit: sourceCommit ?? undefined,
					fresh,
					task: parentTask,
				});

				const selected = preparationsByName.get(closurePlan.selected)!;
				const repositoryName = getGitHubRepositoryName(remoteUrl);
				if (repositoryName) {
					const successLink = terminalLink(
						`${cyan(selected.publication.branch)} ${dim(`(${selected.publication.commit})`)}`,
						`https://github.com/${repositoryName}/tree/${selected.publication.branch!}`,
					);
					setTitle(`Published ${stringify(closurePlan.selected)} from ${stringify(sourceName)}: ${successLink}`);
				} else {
					setTitle(`Published ${stringify(closurePlan.selected)} from ${stringify(sourceName)}`);
				}

				return selected;
			},
		).catch(() => {
			// Any failure here is already rendered within the task tree above
			// (including the pack subprocess output), so exit without re-printing it.
			// Set exitCode (instead of process.exit) so tasuku can flush its final render.
			process.exitCode = 1;
		});
		if (workspacePublish?.result) {
			const installSpecifier = getGitHubInstallSpecifier(
				remoteUrl,
				workspacePublish.result.publication.commit,
			) ?? workspacePublish.result.publication.installSpecifier;
			process.once('exit', () => {
				fsSync.writeSync(process.stdout.fd, `\n→ Install command\n  ${packageManager} i '${installSpecifier}'\n`);
			});
		}
		return;
	}

	const workspaceDependencies: string[] = [];
	for (const [field, dependencies] of Object.entries({
		dependencies: packageJson.dependencies,
		optionalDependencies: packageJson.optionalDependencies,
	})) {
		if (!dependencies) {
			continue;
		}

		for (const [name, specification] of Object.entries(dependencies)) {
			if (specification?.startsWith('workspace:')) {
				workspaceDependencies.push(`- ${field}.${name}: ${specification}`);
			}
		}
	}
	if (workspaceDependencies.length > 0) {
		throw new Error(`Cannot publish packages with workspace dependencies:
${workspaceDependencies.join('\n')}
Pre-bundle these dependencies before publishing.`);
	}

	const gitSubdirectory = path.relative(gitRootPath, cwd);
	const defaultPublishBranch = gitSubdirectory
		? `npm/${sourceName}-${packageJson.name}`
		: `npm/${sourceName}`;
	const publishBranch = branch
		? renderPackageBranch({
			template: branch,
			gitRef: sourceName,
			gitSha: sourceCommitId,
			packageName: packageJson.name!,
		})
		: defaultPublishBranch;
	try {
		await getStdout(spawn('git', ['check-ref-format', '--branch', publishBranch]));
	} catch {
		throw new Error(`Invalid publish branch ${stringify(publishBranch)}.`);
	}
	const publishRemote = await getPublishRemote(gitRootPath, remote, usedDefaultRemote);
	const remoteUrl = publishRemote.fetchUrl;

	await task(
		`Publishing source ${stringify(sourceName)} → ${stringify(publishBranch)}`,
		async ({
			task, setTitle, setStatus, setOutput,
		}) => {
			if (dry) {
				setStatus('Dry run');
			}

			const localTemporaryBranch = `git-publish-${randomBytes(16).toString('hex')}`;
			let publishRepository: PublishRepository;

			let success = false;

			let commitSha: string;
			let primaryError: unknown;
			let cleanupFailed = false;

			try {
				const creatingWorktrees = await task('Creating temporary repositories', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					publishRepository = await createPublishRepository({
						sourceRepositoryPath: gitRootPath,
						publishRemote,
					});
				});

				if (!dry) {
					creatingWorktrees.clear();
				}

				const checkoutBranch = await task('Loading publish branch', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await preparePublishBranch({
						repository: publishRepository,
						publishBranch,
						localBranch: localTemporaryBranch,
						fresh,
					});
				});

				if (!dry) {
					checkoutBranch.clear();
				}

				const packTask = await task('Packing package', async ({ streamPreview, setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					let tarballPath;
					try {
						tarballPath = await packPackage(
							packageManager,
							publishRepository.packWorktreePath,
							publishRepository.packTemporaryDirectory,
							cwd,
							gitRootPath,
							gitSubdirectory,
						);
					} catch (error) {
						// The pack subprocess (e.g. a failing prepack/build script) captures
						// the real reason in its output, but nano-spawn's error.message only
						// says "Command failed with exit code N". Surface the output inline
						// under this task so the failure is diagnosable.
						if (error instanceof SubprocessError) {
							const details = error.output || error.stderr;
							if (details) {
								streamPreview.write(details);
							}
						}
						throw error;
					}

					return tarballPath;
				});

				if (!dry) {
					packTask.clear();
				}

				const commit = await task('Committing publish assets', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					const preparation = await preparePackagePublication({
						packageName: packageJson.name!,
						packedTarball: packTask.result!,
						publishWorktree: publishRepository.publishWorktreePath,
						branch: publishBranch,
						fetchUrl: remoteUrl,
						sourceName,
						sourceCommit: sourceCommit ?? undefined,
						dependencyEdges: [],
						dependencyPublications: new Map(),
						gitOptions: publishRepository.gitOptions,
					});
					const publishFiles = preparation.files;

					const totalSize = publishFiles.reduce((accumulator, { size }) => accumulator + size, 0);

					console.log(lightBlue(`Publishing ${packageJson.name}`));
					console.log(publishFiles.map(({ file, size }) => `${file} ${dim(byteSize(size).toString())}`).join('\n'));
					console.log(`\n${lightBlue('Total size')}`, byteSize(totalSize).toString());

					if (preparation.reusedExistingCommit) {
						console.warn('⚠️  No new changes found to commit.');
					}

					commitSha = preparation.publication.commit;
				});

				if (!dry) {
					commit.clear();
				}

				const push = await task(
					`Pushing branch ${stringify(publishBranch)} to remote ${stringify(remote)}`,
					async ({ setStatus, setWarning }) => {
						if (dry) {
							setWarning('');
							return;
						}

						const { pushRemoteNames } = publishRepository;
						for (const [index, pushRemoteName] of pushRemoteNames.entries()) {
							setStatus(`${index + 1} of ${pushRemoteNames.length}`);
							await spawn('git', [
								'push',
								...(fresh ? ['--force'] : []),
								'--no-verify',
								pushRemoteName,
								`HEAD:${publishBranch}`,
							], publishRepository.gitOptions);
						}
						success = true;
					},
				);

				if (!dry) {
					push.clear();
				}
			} catch (error) {
				primaryError = error;
				throw error;
			} finally {
				const cleanup = await task('Cleaning up', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					if (publishRepository) {
						await publishRepository.dispose().catch((error: unknown) => {
							cleanupFailed = true;
							setWarning(getErrorDetails(error));
							if (!primaryError) {
								return;
							}
							throw new AggregateError([primaryError, error], 'Failed to publish package.');
						});
					}
				});

				if (!cleanupFailed) {
					cleanup.clear();
				}
			}

			if (success) {
				const repositoryName = getGitHubRepositoryName(remoteUrl);
				if (repositoryName) {
					const successLink = terminalLink(
						`${cyan(publishBranch)} ${dim(`(${commitSha!})`)}`,
						`https://github.com/${repositoryName}/tree/${publishBranch!}`,
					);
					setTitle(`Successfully published branch: ${successLink}`);

					const output = [
						'Install command',
						`${packageManager} i '${getGitHubInstallSpecifier(remoteUrl, publishBranch) ?? `${remoteUrl}#${publishBranch}`}'`,
					].join('\n');

					setOutput(output);
				}
			}
		},
	).catch(() => {
		// Any failure here is already rendered within the task tree above
		// (including the pack subprocess output), so exit without re-printing it.
		// Set exitCode (instead of process.exit) so tasuku can flush its final render.
		process.exitCode = 1;
	});
})().catch((error) => {
	console.error('Error:', error.message);
	process.exit(1);
});
