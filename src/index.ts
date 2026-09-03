import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
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
import {
	getGitConfig, serializeGitConfig, type GitConfigEntry,
} from './utils/git-config.ts';

const { stringify } = JSON;

const isSerializableGitConfig = ({ key }: GitConfigEntry) => key !== 'core.bare'
	&& key !== 'core.worktree'
	&& key !== 'core.repositoryformatversion'
	&& !key.startsWith('extensions.')
	&& key !== 'include.path'
	&& !key.startsWith('includeif.');

const isLocalGitUrl = (url: string) => url.startsWith('file://')
	|| /^[a-z]:[\\/]/i.test(url)
	|| (!/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^[^/:]+:/.test(url));

const getGitServerCommand = (url: string, command: string) => (isLocalGitUrl(url)
	? `env -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_GLOBAL ${command}`
	: command);

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
		await getStdout(spawn('git', ['check-ref-format', '--branch', publishBranch]));
	} catch {
		throw new Error(`Invalid publish branch ${stringify(publishBranch)}.`);
	}

	let configuredRemote = true;
	const remoteUrl = await getStdout(spawn('git', ['remote', 'get-url', remote])).catch(() => {
		configuredRemote = false;
		if (usedDefaultRemote) {
			throw new Error(`Git remote ${stringify(remote)} does not exist`);
		}

		// Git accepts raw destinations as well as configured remote names.
		return remote;
	});
	const pushUrlOutput = await getStdout(spawn('git', ['remote', 'get-url', '--push', '--all', remote])).catch(() => remoteUrl);
	const sourceGitConfig = await getGitConfig();
	const remoteConfigPrefix = `remote.${remote}.`;
	const sourceRemoteConfig = configuredRemote
		? sourceGitConfig.filter(({ key }) => key.startsWith(remoteConfigPrefix) && key !== `${remoteConfigPrefix}url` && key !== `${remoteConfigPrefix}pushurl`)
		: [];
	const sourceTransportConfig = sourceGitConfig
		.filter(({ key }) => !key.startsWith('remote.'))
		.filter(isSerializableGitConfig);
	const pushUrls = pushUrlOutput.split('\n');

	await task(
		`Publishing source ${stringify(sourceName)} → ${stringify(publishBranch)}`,
		async ({
			task, setTitle, setStatus, setOutput,
		}) => {
			if (dry) {
				setStatus('Dry run');
			}

			const localTemporaryBranch = `git-publish-${randomBytes(16).toString('hex')}`;
			let temporaryDirectory = '';
			let publishWorktreePath = '';
			let packWorktreePath = '';
			let packTemporaryDirectory = '';
			const publishGitEnvironment = {
				GIT_CONFIG_SYSTEM: '',
				GIT_CONFIG_GLOBAL: '',
			};
			const publishGitOptions = {
				cwd: '',
				env: publishGitEnvironment,
			};
			const pushRemoteNames = pushUrls.map((_, index) => `publish-${index}`);

			let success = false;

			let commitSha: string;
			const packageManager = await detectPackageManager(cwd, gitRootPath);
			let packWorktreeNeedsCleanup = false;
			let primaryError: unknown;

			try {
				const creatingWorktrees = await task('Creating temporary repositories', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-'));
					// Restrict package files and Git metadata in the workspace to the current user.
					await fs.chmod(temporaryDirectory, 0o700);
					publishWorktreePath = path.join(temporaryDirectory, 'publish-worktree');
					packWorktreePath = path.join(temporaryDirectory, 'pack-worktree');
					packTemporaryDirectory = path.join(temporaryDirectory, 'pack');
					publishGitEnvironment.GIT_CONFIG_SYSTEM = path.join(temporaryDirectory, 'system-config');
					publishGitEnvironment.GIT_CONFIG_GLOBAL = path.join(temporaryDirectory, 'global-config');
					publishGitOptions.cwd = publishWorktreePath;
					const sourcePublishConfig = [
						...sourceTransportConfig,
					];
					await Promise.all([
						fs.writeFile(publishGitEnvironment.GIT_CONFIG_SYSTEM, sourcePublishConfig.filter(({ scope }) => scope === 'system').map(serializeGitConfig).join('')),
						fs.writeFile(publishGitEnvironment.GIT_CONFIG_GLOBAL, sourcePublishConfig.filter(({ scope }) => scope === 'global').map(serializeGitConfig).join('')),
					]);
					await spawn('git', ['clone', '--shared', '--no-checkout', gitRootPath, publishWorktreePath], { env: publishGitEnvironment });
					await spawn('git', ['remote', 'set-url', 'origin', remoteUrl], publishGitOptions);
					for (const [index, pushUrl] of pushUrls.entries()) {
						await spawn('git', ['remote', 'add', pushRemoteNames[index], pushUrl], publishGitOptions);
					}
					const remoteNames = ['origin', ...pushRemoteNames];
					await fs.appendFile(path.join(publishWorktreePath, '.git', 'config'), [
						...sourcePublishConfig.filter(({ scope }) => scope === 'local' || scope === 'worktree'),
						...remoteNames.flatMap(remoteName => sourceRemoteConfig.map(entry => ({
							...entry,
							key: `remote.${remoteName}.${entry.key.slice(remoteConfigPrefix.length)}`,
						}))),
					].map(serializeGitConfig).join(''));
					if (isLocalGitUrl(remoteUrl)) {
						const uploadPack = await getStdout(spawn('git', ['config', '--get', 'remote.origin.uploadpack'], publishGitOptions)).catch(() => 'git-upload-pack');
						await spawn('git', ['config', 'remote.origin.uploadpack', getGitServerCommand(remoteUrl, uploadPack)], publishGitOptions);
					}
					for (const [index, pushUrl] of pushUrls.entries()) {
						if (!isLocalGitUrl(pushUrl)) {
							continue;
						}

						const receivePack = await getStdout(spawn('git', ['config', '--get', `remote.${pushRemoteNames[index]}.receivepack`], publishGitOptions)).catch(() => 'git-receive-pack');
						await spawn('git', ['config', `remote.${pushRemoteNames[index]}.receivepack`, getGitServerCommand(pushUrl, receivePack)], publishGitOptions);
					}

					packWorktreeNeedsCleanup = true;
					await spawn('git', ['worktree', 'add', '--force', packWorktreePath, 'HEAD'], publishGitOptions);
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
								'origin',
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
								'origin',
								`${publishBranch}:${localTemporaryBranch}`,
							], publishGitOptions);
						}
					}

					if (orphan) {
						// Fresh orphan branch with no history
						await spawn('git', ['checkout', '--orphan', localTemporaryBranch], publishGitOptions);
					} else {
						// Repoint HEAD to the fetched branch without checkout
						await spawn('git', ['symbolic-ref', 'HEAD', `refs/heads/${localTemporaryBranch}`], publishGitOptions);
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

						for (const pushRemoteName of pushRemoteNames) {
							await spawn('git', [
								'push',
								...(fresh ? ['--force'] : []),
								'--no-verify',
								pushRemoteName,
								`HEAD:${publishBranch}`,
							], publishGitOptions);
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

					const cleanupErrors: unknown[] = [];
					const runCleanup = async (operation: Promise<unknown>) => {
						try {
							await operation;
						} catch (error) {
							cleanupErrors.push(error);
						}
					};

					if (packWorktreeNeedsCleanup) {
						await runCleanup(spawn('git', ['worktree', 'remove', '--force', packWorktreePath], publishGitOptions));
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
