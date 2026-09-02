import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import spawn, { SubprocessError } from 'nano-spawn';
import task from 'tasuku';
import { cli } from 'cleye';
import type { PackageJson } from '@npmcli/package-json';
import byteSize from 'byte-size';
import { cyan, dim, lightBlue } from 'kolorist';
import terminalLink from 'terminal-link';
import packageMeta from '../package.json' with { type: 'json' };
import { simpleSpawn } from './utils/simple-spawn.ts';
import {
	assertCleanTree, getCurrentSourceName, gitStatusTracked, getCurrentCommit,
} from './utils/git.ts';
import { readJson } from './utils/read-json.ts';
import { detectPackageManager } from './utils/detect-package-manager.ts';
import { packPackage } from './utils/pack-package.ts';
import { extractTarball } from './utils/extract-tarball.ts';
import { getGitHubRepositoryName } from './utils/github.ts';

const { stringify } = JSON;

type GitConfigEntry = {
	scope: string;
	key: string;
	value: string;
};

const parseGitConfig = (
	config: string,
	scope: string,
) => {
	const fields = config.split('\0');
	const entries: GitConfigEntry[] = [];
	for (const field of fields) {
		if (!field) {
			continue;
		}

		const separatorIndex = field.indexOf('\n');
		entries.push({
			scope,
			key: field.slice(0, separatorIndex),
			value: field.slice(separatorIndex + 1),
		});
	}

	return entries;
};

const serializeGitConfig = ({ key, value }: GitConfigEntry) => {
	const firstSeparatorIndex = key.indexOf('.');
	const lastSeparatorIndex = key.lastIndexOf('.');
	const section = key.slice(0, firstSeparatorIndex);
	const subsection = firstSeparatorIndex === lastSeparatorIndex
		? ''
		: ` "${key.slice(firstSeparatorIndex + 1, lastSeparatorIndex).replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
	const variable = key.slice(lastSeparatorIndex + 1);
	const escapedValue = value
		.replaceAll('\\', String.raw`\\`)
		.replaceAll('"', String.raw`\"`)
		.replaceAll('\n', String.raw`\n`)
		.replaceAll('\t', String.raw`\t`);
	return `[${section}${subsection}]\n\t${variable} = "${escapedValue}"\n`;
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
	const gitRootPath = await simpleSpawn('git', ['rev-parse', '--show-toplevel']);
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

	const {
		branch, remote, fresh, dry,
	} = argv.flags;

	const publishBranch = branch || (
		gitSubdirectory
			? `npm/${sourceName}-${packageJson.name}`
			: `npm/${sourceName}`
	);
	try {
		await simpleSpawn('git', ['check-ref-format', '--branch', publishBranch]);
	} catch {
		throw new Error(`Invalid publish branch ${stringify(publishBranch)}.`);
	}

	const remoteUrl = await simpleSpawn('git', ['remote', 'get-url', remote]).catch(() => {
		if (usedDefaultRemote) {
			throw new Error(`Git remote ${stringify(remote)} does not exist`);
		}

		// Git accepts raw destinations as well as configured remote names.
		return remote;
	});
	const sourceObjectsPath = path.resolve(cwd, await simpleSpawn('git', ['rev-parse', '--git-path', 'objects']));
	const [sourceLocalConfigResult, sourceGlobalConfig] = await Promise.all([
		spawn('git', ['config', '--local', '--includes', '--null', '--list']),
		simpleSpawn('git', ['config', '--global', '--includes', '--null', '--list']).catch(() => ''),
	]);
	const sourceLocalConfig = parseGitConfig(sourceLocalConfigResult.stdout, 'local');
	const worktreeConfigEnabled = sourceLocalConfig.some(({ key, value }) => key === 'extensions.worktreeconfig' && value === 'true');
	const sourceWorktreeConfigResult = worktreeConfigEnabled
		? await spawn('git', ['config', '--worktree', '--includes', '--null', '--list'])
		: undefined;
	const sourceGitConfig = [
		...parseGitConfig(sourceGlobalConfig, 'global'),
		...sourceLocalConfig,
		...(sourceWorktreeConfigResult ? parseGitConfig(sourceWorktreeConfigResult.stdout, 'worktree') : []),
	];
	const objectFormat = sourceLocalConfig.find(({ key }) => key === 'extensions.objectformat')?.value;

	await task(
		`Publishing source ${stringify(sourceName)} → ${stringify(publishBranch)}`,
		async ({
			task, setTitle, setStatus, setOutput,
		}) => {
			if (dry) {
				setStatus('Dry run');
			}

			const temporaryPublishBranch = `git-publish-${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
			const temporaryDirectory = path.join(os.tmpdir(), 'git-publish', temporaryPublishBranch);
			const publishWorktreePath = path.join(temporaryDirectory, 'publish-worktree');
			const packWorktreePath = path.join(temporaryDirectory, 'pack-worktree');
			const packTemporaryDirectory = path.join(temporaryDirectory, 'pack');
			const publishGitOptions = {
				cwd: publishWorktreePath,
				env: {
					GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjectsPath,
				},
			};

			let success = false;

			let commitSha: string;
			const packageManager = await detectPackageManager(cwd, gitRootPath);
			let packWorktreeNeedsCleanup = false;
			let primaryError: unknown;

			try {
				const creatingWorktrees = await task('Creating worktrees', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await spawn('git', [
						'init',
						...(objectFormat && objectFormat !== 'sha1' ? [`--object-format=${objectFormat}`] : []),
						publishWorktreePath,
					]);
					const publishGlobalConfig = await simpleSpawn('git', ['config', '--global', '--includes', '--null', '--list'], publishGitOptions).catch(() => '');
					const inheritedConfigCounts = new Map<string, number>();
					for (const { key, value } of parseGitConfig(publishGlobalConfig, 'global')) {
						const signature = `${key}\0${value}`;
						inheritedConfigCounts.set(signature, (inheritedConfigCounts.get(signature) || 0) + 1);
					}

					// Copy repository config and global values selected only for the source Git directory.
					const publishConfigEntries = sourceGitConfig.filter((entry) => {
						const { scope, key, value } = entry;
						if (key === 'core.bare' || key === 'core.worktree' || key === 'core.repositoryformatversion' || key.startsWith('extensions.') || key === 'include.path' || key.startsWith('includeif.')) {
							return false;
						}

						if (scope === 'local' || scope === 'worktree') {
							return true;
						}

						if (scope !== 'global') {
							return false;
						}

						const signature = `${key}\0${value}`;
						const inheritedCount = inheritedConfigCounts.get(signature) || 0;
						if (inheritedCount === 0) {
							return true;
						}

						inheritedConfigCounts.set(signature, inheritedCount - 1);
						return false;
					});
					await fs.appendFile(
						path.join(publishWorktreePath, '.git', 'config'),
						publishConfigEntries.map(serializeGitConfig).join(''),
					);

					// A failed hook can leave Git's worktree registration behind.
					packWorktreeNeedsCleanup = true;
					await spawn('git', ['worktree', 'add', '--force', packWorktreePath, 'HEAD']);
				});

				if (!dry) {
					creatingWorktrees.clear();
				}

				const checkoutBranch = await task('Checking out branch', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					let orphan = false;
					if (fresh) {
						orphan = true;
					} else {
						try {
							await spawn('git', [
								'ls-remote',
								'--exit-code',
								'--branches',
								remote,
								`refs/heads/${publishBranch}`,
							], publishGitOptions);
						} catch (error) {
							if (!(error instanceof SubprocessError) || error.exitCode !== 2) {
								throw error;
							}

							orphan = true;
						}

						if (!orphan) {
							await spawn('git', [
								'fetch',
								'--depth=1',
								'--no-tags',
								remote,
								`${publishBranch}:${temporaryPublishBranch}`,
							], publishGitOptions);
						}
					}

					if (orphan) {
						// Fresh orphan branch with no history
						await spawn('git', ['checkout', '--orphan', temporaryPublishBranch], publishGitOptions);
					} else {
						// Repoint HEAD to the fetched branch without checkout
						await spawn('git', ['symbolic-ref', 'HEAD', `refs/heads/${temporaryPublishBranch}`], publishGitOptions);
					}

					// Remove all files from index and working directory

					// removes tracked files from index (.catch() since it fails on empty orphan branches)
					await spawn('git', ['rm', '--cached', '-r', ':/'], publishGitOptions).catch(() => {});

					// removes all untracked files from the working directory
					await spawn('git', ['clean', '-fdx'], publishGitOptions);
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
							packWorktreePath,
							packTemporaryDirectory,
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

					const publishFiles = await extractTarball(tarballPath, publishWorktreePath);
					const publishedPackageJsonPath = path.join(publishWorktreePath, packageJsonPath);
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

				const commit = await task('Commiting publish assets', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await spawn('git', ['add', '-A'], publishGitOptions);

					const publishFiles = await packTask.result;
					if (!publishFiles || publishFiles.length === 0) {
						throw new Error('No publish files found');
					}

					const totalSize = publishFiles.reduce((accumulator, { size }) => accumulator + size, 0);

					console.log(lightBlue(`Publishing ${packageJson.name}`));
					console.log(publishFiles.map(({ file, size }) => `${file} ${dim(byteSize(size).toString())}`).join('\n'));
					console.log(`\n${lightBlue('Total size')}`, byteSize(totalSize).toString());

					const trackedFiles = await gitStatusTracked(publishGitOptions);
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
							publishGitOptions,
						);
					}

					commitSha = (await getCurrentCommit(publishGitOptions))!;
				});

				if (!dry) {
					commit.clear();
				}

				const push = await task(
					`Pushing branch ${stringify(publishBranch)} to remote ${stringify(remote)}`,
					async ({ setWarning }) => {
						if (dry) {
							setWarning('');
							return;
						}

						await spawn('git', [
							'push',
							...(fresh ? ['--force'] : []),
							'--no-verify',
							remote,
							`HEAD:${publishBranch}`,
						], publishGitOptions);
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

					const cleanupErrors: unknown[] = [];
					const runCleanup = async (operation: Promise<unknown>) => {
						try {
							await operation;
						} catch (error) {
							cleanupErrors.push(error);
						}
					};

					if (packWorktreeNeedsCleanup) {
						await runCleanup(spawn('git', ['worktree', 'remove', '--force', packWorktreePath]));
					}

					await runCleanup(fs.rm(temporaryDirectory, {
						recursive: true,
						force: true,
					}));

					if (cleanupErrors.length > 0) {
						setWarning(cleanupErrors.map(error => (error instanceof Error ? error.message : String(error))).join('\n'));
						if (!primaryError) {
							throw new AggregateError(cleanupErrors, 'Failed to clean up temporary publish resources.');
						}
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
