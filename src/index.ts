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
import { readJson } from './utils/read-json.js';
import { detectPackageManager } from './utils/detect-package-manager.js';
import { packPackage } from './utils/pack-package.js';
import { extractTarball, type File } from './utils/extract-tarball.js';

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
			const temporaryDirectory = path.join(os.tmpdir(), 'git-publish', localTemporaryBranch);
			const worktreePath = path.join(temporaryDirectory, 'worktree');
			const packTemporaryDirectory = path.join(temporaryDirectory, 'pack');

			let success = false;

			let remoteUrl;
			try {
				remoteUrl = await simpleSpawn('git', ['remote', 'get-url', remote]);
			} catch {
				throw new Error(`Git remote ${stringify(remote)} does not exist`);
			}

			let commitSha: string;
			const packageManager = await detectPackageManager(cwd, gitRootPath);

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

					// Remove all files from index and working directory

					// removes tracked files from index (.catch() since it fails on empty orphan branches)
					await spawn('git', ['rm', '--cached', '-r', ':/'], { cwd: worktreePath }).catch(() => {});

					// removes all untracked files from the working directory
					await spawn('git', ['clean', '-fdx'], { cwd: worktreePath });
				});

				if (!dry) {
					checkoutBranch.clear();
				}

				const packTask = await task('Packing package', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					const tarballPath = await packPackage(
						packageManager,
						cwd,
						packTemporaryDirectory,
					);

					return await extractTarball(tarballPath, worktreePath);
				});

				if (!dry) {
					packTask.clear();
				}

				const commit = await task('Commiting publish assets', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await spawn('git', ['add', '-A'], { cwd: worktreePath });

					const publishFiles = await packTask.result;
					if (!publishFiles || publishFiles.length === 0) {
						throw new Error('No publish files found');
					}

					const totalSize = publishFiles.reduce((accumulator, { size }) => accumulator + size, 0);

					console.log(lightBlue(`Publishing ${packageJson.name}`));
					console.log(publishFiles.map(({ file, size }) => `${file} ${dim(byteSize(size).toString())}`).join('\n'));
					console.log(`\n${lightBlue('Total size')}`, byteSize(totalSize).toString());

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
					await fs.rm(temporaryDirectory, {
						recursive: true,
						force: true,
					});
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
