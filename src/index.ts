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
} from './utils/git.ts';
import { readJson } from './utils/read-json.ts';
import { detectPackageManager } from './utils/detect-package-manager.ts';
import { packPackage } from './utils/pack-package.ts';
import { extractTarball } from './utils/extract-tarball.ts';
import { getGitHubRepositoryName } from './utils/github.ts';
import { createPublishRepository, type PublishRepository } from './publish-repository/create.ts';
import { preparePublishBranch } from './publish-repository/prepare-branch.ts';
import { getPublishRemote } from './publish-repository/remote.ts';
import {
	formatClosurePlan,
	planWorkspacePublication,
	publishWorkspaceClosure,
	type PackagePreparation,
} from './publish-repository/publish-closure.ts';

const { stringify } = JSON;

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
				placeholder: '<branch name>',
				description: 'The branch to publish the package to. Defaults to prefixing "npm/" to the current branch or tag name.',
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
	const closurePackageManager = await detectPackageManager(cwd, gitRootPath);
	const closurePlan = await planWorkspacePublication({
		cwd,
		gitRootPath,
		sourceName,
		packageManager: closurePackageManager,
	}).catch(() => undefined);
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

	const {
		branch, remote, fresh, dry,
	} = argv.flags;

	const publishBranch = branch || (
		gitSubdirectory
			? `npm/${sourceName}-${packageJson.name}`
			: `npm/${sourceName}`
	);
	try {
		await getStdout(spawn('git', ['check-ref-format', '--branch', publishBranch]));
	} catch {
		throw new Error(`Invalid publish branch ${stringify(publishBranch)}.`);
	}
	const publishRemote = await getPublishRemote(gitRootPath, remote, usedDefaultRemote);
	const remoteUrl = publishRemote.fetchUrl;

	if (closurePlan) {
		if (branch) {
			throw new Error('The --branch flag is not supported for workspace publication. Each package publishes to its own derived branch.');
		}
		if (publishRemote.pushUrls.length !== 1) {
			throw new Error(`Workspace publication requires exactly one push URL, but remote ${stringify(remote)} has ${publishRemote.pushUrls.length}.`);
		}

		if (dry) {
			console.log(formatClosurePlan(closurePlan, sourceName));
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
						preparations = await publishWorkspaceClosure({
							plan: closurePlan,
							packageManager: closurePackageManager,
							sourceRepositoryPath: gitRootPath,
							gitRootPath,
							publishRemote,
							sourceName,
							sourceCommit: sourceCommit ?? undefined,
							fresh,
						});
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
