import path from 'node:path';
import fs from 'node:fs/promises';
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
	assertCleanTree, getCurrentSourceName, gitStatusTracked, getCurrentCommit,
	getCurrentCommitId,
} from './utils/git.ts';
import { readJson } from './utils/read-json.ts';
import { detectPackageManager } from './utils/detect-package-manager.ts';
import { packPackage } from './utils/pack-package.ts';
import { extractTarball } from './utils/extract-tarball.ts';
import { getGitHubRepositoryName } from './utils/github.ts';
import { createPublishRepository, type PublishRepository } from './publish-repository/create.ts';
import { preparePublishBranch } from './publish-repository/prepare-branch.ts';
import { getPublishRemote } from './publish-repository/remote.ts';
import { renderPackageBranch } from './package-publication/branch.ts';
import type { PackagePreparation } from './package-publication/prepare.ts';
import { assertAtomicPackagePublicationDestination } from './package-publication/push.ts';
import { planWorkspacePublication, type WorkspacePublicationPlan } from './workspace-publication/plan.ts';
import { publishWorkspaceClosure } from './workspace-publication/publish.ts';

const { stringify } = JSON;

const formatWorkspacePublicationPlan = (
	plan: WorkspacePublicationPlan,
	sourceName: string,
): string => {
	const lines = [`Publishing workspace closure from ${JSON.stringify(sourceName)}:`];
	for (const node of plan.graph.nodes) {
		const branch = plan.branches.get(node.key)!;
		const rewrites = node.dependencies.map(edge => `${edge.key} → ${plan.branches.get(edge.target)!}`).join(', ');
		lines.push(`- ${node.key} → ${branch}${rewrites ? ` (dependencies: ${rewrites})` : ''}`);
	}
	return lines.join('\n');
};

const formatWorkspacePeerDiagnostics = (plan: WorkspacePublicationPlan): string | undefined => {
	if (plan.graph.peers.length === 0) {
		return undefined;
	}
	const lines = ['Internal workspace peer dependencies are not published. Consumers must provide them:'];
	for (const peer of plan.graph.peers) {
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
	const gitSubdirectory = path.relative(gitRootPath, cwd);
	const sourceName = await getCurrentSourceName();
	const sourceCommit = await getCurrentCommit();
	const sourceCommitId = await getCurrentCommitId();
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

	const workspaceDependencies: string[] = [];
	const {
		branch, remote, fresh, dry,
	} = argv.flags;
	const closurePackageManager = await detectPackageManager(cwd, gitRootPath);
	const closurePlan = await planWorkspacePublication({
		cwd,
		gitRootPath,
		sourceName,
		sourceCommitId,
		packageManager: closurePackageManager,
		publishBranch: branch,
	});
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

	if (!closurePlan && workspaceDependencies.length > 0) {
		throw new Error(`Cannot publish packages with workspace dependencies:
${workspaceDependencies.join('\n')}
Pre-bundle these dependencies before publishing.`);
	}

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

	if (closurePlan) {
		assertAtomicPackagePublicationDestination(publishRemote.pushUrls);

		if (dry) {
			console.log(formatWorkspacePublicationPlan(closurePlan, sourceName));
		}
		const peerDiagnostics = formatWorkspacePeerDiagnostics(closurePlan);
		if (peerDiagnostics) {
			console.warn(peerDiagnostics);
		}

		const packageCount = closurePlan.graph.nodes.length;
		await task(
			`Publishing workspace closure ${stringify(closurePlan.graph.selected)} from ${stringify(sourceName)} (${packageCount} packages)`,
			async ({ setTitle, setStatus, setOutput }) => {
				if (dry) {
					setStatus('Dry run');
				}

				let success = false;
				let preparations: PackagePreparation[] = [];

				try {
					if (!dry) {
						const result = await publishWorkspaceClosure({
							plan: closurePlan,
							packageManager: closurePackageManager,
							sourceRepositoryPath: gitRootPath,
							gitRootPath,
							publishRemote,
							sourceName,
							sourceCommit: sourceCommit ?? undefined,
							fresh,
						});
						preparations = closurePlan.graph.nodes.map(node => result.preparations.get(node.key)!);
						success = true;
					}
				} catch (error) {
					if (error instanceof SubprocessError) {
						const details = error.output || error.stderr;
						if (details) {
							console.error(details);
						}
					}
					throw error;
				}

				for (const preparation of preparations) {
					if (preparation.reusedExistingCommit) {
						console.warn(`⚠️  No new changes found for ${preparation.publication.packageName}, keeping the existing publish branch.`);
					}
					console.log(lightBlue(`Publishing ${preparation.publication.packageName}`));
					console.log(preparation.files.map(({ file, size }) => `${file} ${dim(byteSize(size).toString())}`).join('\n'));
					console.log(`\n${lightBlue('Total size')}`, byteSize(preparation.files.reduce((total, { size }) => total + size, 0)).toString());
				}

				if (success) {
					const selectedName = closurePlan.graph.selected;
					const selected = preparations.find(
						preparation => preparation.publication.packageName === selectedName,
					);
					if (!selected) {
						throw new Error(`Missing publication for ${JSON.stringify(selectedName)}.`);
					}
					const repositoryName = getGitHubRepositoryName(remoteUrl);
					if (repositoryName) {
						const successLink = terminalLink(
							`${cyan(selected.publication.branch)} ${dim(`(${selected.publication.commit})`)}`,
							`https://github.com/${repositoryName}/tree/${selected.publication.branch!}`,
						);
						setTitle(`Successfully published ${packageCount} packages: ${successLink}`);
					} else {
						setTitle(`Successfully published ${packageCount} packages`);
					}

					const output = [
						'Install command',
						`${closurePackageManager} i '${selected.publication.installSpecifier}'`,
					].join('\n');

					setOutput(output);
				}
			},
		).catch(() => {
			// Any failure here is already rendered within the task tree above
			// (including the pack subprocess output), so exit without re-printing it.
			// Set exitCode (instead of process.exit) so tasuku can flush its final render.
			process.exitCode = 1;
		});
		return;
	}

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
			const packageManager = await detectPackageManager(cwd, gitRootPath);
			let primaryError: unknown;

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

					const publishFiles = await extractTarball(
						tarballPath,
						publishRepository.publishWorktreePath,
					);
					const publishedPackageJsonPath = path.join(
						publishRepository.publishWorktreePath,
						packageJsonPath,
					);
					const publishedPackageJson = await readJson(publishedPackageJsonPath) as PackageJson;
					const { scripts } = publishedPackageJson;
					if (scripts && ('prepare' in scripts || 'prepack' in scripts)) {
						/*
						 * npm reruns these hooks when installing Git dependencies:
						 * https://github.com/npm/cli/blob/2a03860fcafe92b22770fc554b25994b29bacbdb/docs/lib/content/using-npm/scripts.md#L49-L65
						 */
						delete scripts.prepare;
						delete scripts.prepack;
						await fs.writeFile(publishedPackageJsonPath, stringify(publishedPackageJson, null, 2));
					}

					return publishFiles;
				});

				if (!dry) {
					packTask.clear();
				}

				const commit = await task('Committing publish assets', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await spawn('git', ['add', '-A'], publishRepository.gitOptions);

					const publishFiles = await packTask.result;
					if (!publishFiles || publishFiles.length === 0) {
						throw new Error('No publish files found');
					}

					const totalSize = publishFiles.reduce((accumulator, { size }) => accumulator + size, 0);

					console.log(lightBlue(`Publishing ${packageJson.name}`));
					console.log(publishFiles.map(({ file, size }) => `${file} ${dim(byteSize(size).toString())}`).join('\n'));
					console.log(`\n${lightBlue('Total size')}`, byteSize(totalSize).toString());

					const trackedFiles = await gitStatusTracked(publishRepository.gitOptions);
					if (trackedFiles.length === 0) {
						console.warn('⚠️  No new changes found to commit.');
					} else {
						let commitMessage = `Published from "${sourceName}"`;
						if (sourceCommit) {
							commitMessage += ` (${sourceCommit})`;
						}

						await spawn(
							'git',
							[
								'-c',
								'user.name=git-publish',
								'-c',
								'user.email=bot@git-publish',
								'commit',
								'--no-verify',
								'-m',
								commitMessage,
								'--author=git-publish <bot@git-publish>',
							],
							publishRepository.gitOptions,
						);
					}

					commitSha = (await getCurrentCommit(publishRepository.gitOptions))!;
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
							if (error instanceof AggregateError) {
								setWarning(error.errors.map(nested => (nested instanceof Error ? nested.message : String(nested))).join('\n'));
							} else {
								setWarning(error instanceof Error ? error.message : String(error));
							}
							if (!primaryError) {
								throw error;
							}
						});
					}
				});

				cleanup.clear();
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
						`${packageManager} i '${remoteUrl}#${publishBranch}'`,
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
