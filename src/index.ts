import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import spawn, { type SubprocessError } from 'nano-spawn';
import task from 'tasuku';
import { cli } from 'cleye';
import type { PackageJson } from '@npmcli/package-json';
import byteSize from 'byte-size';
import { cyan, dim, lightBlue } from 'kolorist';
import terminalLink from 'terminal-link';
import { name, version, description } from '../package.json';
import { simpleSpawn } from './utils/simple-spawn';
import {
	assertCleanTree, getCurrentBranchOrTagName, gitStatusTracked, getCurrentCommit,
} from './utils/git.js';
import { getNpmPacklist } from './utils/npm-packlist.js';
import { readJson } from './utils/read-json.js';
import { detectPackageManager } from './utils/detect-package-manager.js';

const { stringify } = JSON;

(async () => {
	const argv = cli({
		name,
		version,
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
				placeholder: '<remote>',
				description: 'The remote to push to.',
				default: 'origin',
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
			description,
		},
	});

	await assertCleanTree();

	const cwd = process.cwd();
	const gitRootPath = await simpleSpawn('git', ['rev-parse', '--show-toplevel']);
	const gitSubdirectory = path.relative(gitRootPath, cwd);
	const currentBranch = await getCurrentBranchOrTagName();
	const currentBranchSha = await getCurrentCommit();
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
		branch,
		remote,
		fresh,
		dry,
	} = argv.flags;

	let publishBranch = branch;
	if (!publishBranch) {
		let defaultBranchName = `npm/${currentBranch}`;
		if (gitSubdirectory) {
			defaultBranchName += `-${packageJson.name}`;
		}
		publishBranch = defaultBranchName;
	}

	await task(
		`Publishing branch ${stringify(currentBranch)} → ${stringify(publishBranch)}`,
		async ({
			task, setTitle, setStatus, setOutput,
		}) => {
			if (dry) {
				setStatus('Dry run');
			}

			const localTemporaryBranch = `git-publish-${Date.now()}-${process.pid}`;
			const worktreePath = path.join(os.tmpdir(), localTemporaryBranch);
			const workingDirectory = path.join(worktreePath, gitSubdirectory);

			let success = false;

			let remoteUrl;
			try {
				remoteUrl = await simpleSpawn('git', ['remote', 'get-url', remote]);
			} catch {
				throw new Error(`Git remote ${stringify(remote)} does not exist`);
			}

			let commitSha: string;

			const creatingWorkTree = await task('Creating worktree', async ({ setWarning }) => {
				if (dry) {
					setWarning('');
					return;
				}

				// TODO: maybe delete all worktrees starting with `git-publish-`?

				await spawn('git', ['worktree', 'add', '--force', worktreePath, 'HEAD']);
			});

			if (!dry) {
				creatingWorkTree.clear();
			}

			try {
				const checkoutBranch = await task('Checking out branch', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await fs.symlink(
						path.join(gitRootPath, 'node_modules'),
						path.join(worktreePath, 'node_modules'),
						'dir',
					).catch(() => {});

					if (gitSubdirectory) {
						await fs.symlink(
							path.join(worktreePath, gitSubdirectory),
							path.join(worktreePath, 'git-publish-subdir'),
							'dir',
						).catch(() => {});
					}

					let orphan = false;
					if (fresh) {
						orphan = true;
					} else {
						const fetchResult = await spawn('git', [
							'fetch',
							'--depth=1',
							remote,
							`${publishBranch}:${localTemporaryBranch}`,
						], { cwd: worktreePath }).catch(error => error as SubprocessError);

						// If fetch fails, remote branch doesnt exist yet, so fallback to orphan
						orphan = 'exitCode' in fetchResult;
					}

					if (orphan) {
						// Fresh orphan branch with no history
						await spawn('git', ['checkout', '--orphan', localTemporaryBranch], { cwd: worktreePath });
					} else {
						// Repoint HEAD to the fetched branch without checkout
						await spawn('git', ['symbolic-ref', 'HEAD', `refs/heads/${localTemporaryBranch}`], { cwd: worktreePath });
					}

					// Remove all tracked files from index
					await spawn('git', ['rm', '--cached', '-r', ':/'], { cwd: worktreePath });
				});

				if (!dry) {
					checkoutBranch.clear();
				}

				const runHooks = await task('Running hooks', async ({ setWarning, setTitle }) => {
					if (dry) {
						setWarning('');
						return;
					}

					// Using the deteced package manager might add packageManager to package.json
					setTitle('Running hook "prepare"');
					await spawn('npm', ['run', '--if-present', 'prepare'].filter(Boolean), { cwd: workingDirectory });

					setTitle('Running hook "prepack"');
					await spawn('npm', ['run', '--if-present', 'prepack'].filter(Boolean), { cwd: workingDirectory });
				});

				if (!dry) {
					runHooks.clear();
				}

				const removeHooks = await task('Removing "prepare" & "prepack" hooks', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}
					if (!('scripts' in packageJson) || !packageJson.scripts) {
						return;
					}

					const { scripts } = packageJson;
					let mutated = false;

					/**
					 * npm uses "prepare" script for git dependencies
					 * because its usually unbuilt.
					 *
					 * Since git-publish prebuilds the package, it should
					 * be removed.
					 *
					 * https://docs.npmjs.com/cli/v8/using-npm/scripts#:~:text=NOTE%3A%20If%20a%20package%20being%20installed%20through%20git%20contains%20a%20prepare%20script%2C%20its%20dependencies%20and%20devDependencies%20will%20be%20installed%2C%20and%20the%20prepare%20script%20will%20be%20run%2C%20before%20the%20package%20is%20packaged%20and%20installed.
					 */
					if ('prepare' in scripts) {
						delete scripts.prepare;
						mutated = true;
					}

					/**
					 * Remove "prepack" script
					 * https://github.com/npm/cli/issues/1229#issuecomment-699528830
					 *
					 * Upon installing a git dependency, the prepack script is run
					 * without devdependency installation.
					 */
					if ('prepack' in scripts) {
						delete scripts.prepack;
						mutated = true;
					}

					if (mutated) {
						await fs.writeFile(
							path.join(workingDirectory, packageJsonPath),
							stringify(packageJson, null, 2),
						);
					}
				});

				if (!dry) {
					removeHooks.clear();
				}

				const commit = await task('Commiting publish assets', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					// Often times the build step is not in the lifecycle scripts and is run separately
					// In those cases, we should see if there are any build artifacts in the cwd
					// Then copy them over to the worktree
					const publishFilesCwd = await getNpmPacklist(cwd, packageJson);
					if (publishFilesCwd.length > 0) {
						await Promise.all(
							publishFilesCwd.map(async (file) => {
								const sourceFile = path.join(cwd, file);
								const destinationFile = path.join(workingDirectory, file);
								await fs.mkdir(path.dirname(destinationFile), { recursive: true });

								// Copy only if the destination doesn't exist
								await fs.copyFile(
									sourceFile,
									destinationFile,
									fs.constants.COPYFILE_EXCL,
								).catch(() => {});
							}),
						);
					}

					const publishFiles = await getNpmPacklist(workingDirectory, packageJson);
					if (publishFiles.length === 0) {
						throw new Error('No publish files found');
					}

					const fileSizes = await Promise.all(
						publishFiles.sort().map(async (file) => {
							const { size } = await fs.stat(path.join(workingDirectory, file));
							return {
								file,
								size,
							};
						}),
					);
					const totalSize = fileSizes.reduce((accumulator, { size }) => accumulator + size, 0);

					console.log(lightBlue(`Publishing ${packageJson.name}`));
					console.log(fileSizes.map(({ file, size }) => `${file} ${dim(byteSize(size).toString())}`).join('\n'));
					console.log(`\n${lightBlue('Total size')}`, byteSize(totalSize).toString());

					if (gitSubdirectory) {
						// Move files from the subdirectory to the root of the git project
						await Promise.all(
							publishFiles.map(async (file) => {
								const sourceFile = path.join(workingDirectory, file);
								const destinationFile = path.join(worktreePath, file);
								await fs.mkdir(path.dirname(destinationFile), { recursive: true });

								try {
									await fs.rm(destinationFile, { force: true });
								} catch {}

								await fs.rename(sourceFile, destinationFile);
							}),
						);
					}

					await spawn('git', ['add', '-f', ...publishFiles], { cwd: worktreePath });

					const trackedFiles = await gitStatusTracked({ cwd: worktreePath });
					if (trackedFiles.length === 0) {
						console.warn('⚠️  No new changes found to commit.');
					} else {
						let commitMessage = `Published from "${currentBranch}"`;
						if (currentBranchSha) {
							commitMessage += ` (${currentBranchSha})`;
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
							{ cwd: worktreePath },
						);
					}

					commitSha = (await getCurrentCommit({ cwd: worktreePath }))!;
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
						], { cwd: worktreePath });
						success = true;
					},
				);

				if (!dry) {
					push.clear();
				}
			} finally {
				const cleanup = await task('Cleaning up', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await spawn('git', ['worktree', 'remove', '--force', worktreePath]);
					await spawn('git', ['branch', '-D', localTemporaryBranch]);
				});

				cleanup.clear();
			}

			if (success) {
				const parsedGitUrl = remoteUrl.match(/github\.com:(.+)\.git$/);
				if (parsedGitUrl) {
					const [, repo] = parsedGitUrl;

					const successLink = terminalLink(
						`${cyan(publishBranch)} ${dim(`(${commitSha!})`)}`,
						`https://github.com/${repo}/tree/${publishBranch!}`,
					);
					setTitle(`Successfully published branch: ${successLink}`);

					const packageManager = await detectPackageManager();
					const output = [
						'Install command',
						`${packageManager} i '${repo}#${publishBranch}'`,
					].join('\n');

					setOutput(output);
				}
			}
		},
	);
})().catch((error) => {
	console.error('Error:', error.message);
	process.exit(1);
});
