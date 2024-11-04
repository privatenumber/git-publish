import fs from 'node:fs/promises';
import spawn, { type SubprocessError } from 'nano-spawn';
import task from 'tasuku';
import { cli } from 'cleye';
import type { PackageJson } from '@npmcli/package-json';
import byteSize from 'byte-size';
import { cyan, dim, lightBlue } from 'kolorist';
import terminalLink from 'terminal-link';
import { name, version, description } from '../package.json';
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
		},

		help: {
			description,
		},
	});

	await assertCleanTree();

	const currentBranch = await getCurrentBranchOrTagName();
	const packageJsonPath = 'package.json';

	await fs.access(packageJsonPath).catch(() => {
		throw new Error('No package.json found in current working directory');
	});

	const {
		branch: publishBranch = `npm/${currentBranch}`,
		remote,
		fresh,
		dry,
	} = argv.flags;

	await task(
		`Publishing branch ${stringify(currentBranch)} → ${stringify(publishBranch)}`,
		async ({
			task, setTitle, setStatus, setOutput,
		}) => {
			if (dry) {
				setStatus('Dry run');
			}

			const localTemporaryBranch = `git-publish/${publishBranch}-${Date.now()}`;
			let success = false;

			// Validate remote exists
			let remoteUrl;
			try {
				const getRemoteUrl = await spawn('git', ['remote', 'get-url', remote]);
				remoteUrl = getRemoteUrl.stdout.trim();
			} catch {
				throw new Error(`Git remote ${stringify(remote)} does not exist`);
			}

			let commitSha: string;

			// In the try-finally block in case it modifies the working tree
			// On failure, they will be reverted by the hard reset
			try {
				const checkoutBranch = await task('Checking out branch', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					if (fresh) {
						await spawn('git', ['checkout', '--orphan', localTemporaryBranch]);
					} else {
						const gitFetch = await spawn('git', ['fetch', '--depth=1', remote, `${publishBranch}:${localTemporaryBranch}`]).catch(error => error as SubprocessError);

						// If the branch does not exist, create a new one
						if ('exitCode' in gitFetch) {
							await spawn('git', [
								'checkout',
								'-b',
								localTemporaryBranch,
							]);
						} else {
							// Point HEAD to localTemporaryBranch without changing the working directory files
							// This sets HEAD to the specified branch but doesn't check out its content
							await spawn('git', [
								'symbolic-ref',
								'HEAD',
								`refs/heads/${localTemporaryBranch}`,
							]);
						}
					}
				});

				if (!dry) {
					checkoutBranch.clear();
				}

				const runHooks = await task('Running hooks', async ({ setWarning, setTitle }) => {
					if (dry) {
						setWarning('');
						return;
					}

					setTitle('Running hook "prepare"');
					await spawn('npm', ['run', '--if-present', 'prepare']);

					setTitle('Running hook "prepack"');
					await spawn('npm', ['run', '--if-present', 'prepack']);
				});

				if (!dry) {
					runHooks.clear();
				}

				const packageJson = await readJson(packageJsonPath) as PackageJson;
				const removeHooks = await task('Removing "prepare" & "prepack" hooks', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					// Re-read incase hooks modified the package.json
					if (!('scripts' in packageJson)) {
						return;
					}

					const { scripts } = packageJson;
					if (!scripts) {
						return;
					}

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
							packageJsonPath,
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

					const publishFiles = await getNpmPacklist(
						process.cwd(),
						packageJson,
					);
					if (publishFiles.length === 0) {
						throw new Error('No publish files found');
					}

					const fileSizes = await Promise.all(
						publishFiles.map(async (file) => {
							const { size } = await fs.stat(file);
							return {
								file,
								size,
							};
						}),
					);
					const totalSize = fileSizes.reduce((accumulator, { size }) => accumulator + size, 0);

					console.log(lightBlue('Publishing files'));
					console.log(fileSizes.map(({ file, size }) => `${file} ${dim(byteSize(size).toString())}`).join('\n'));
					console.log(`\n${lightBlue('Total size')}`, byteSize(totalSize).toString());

					// Remove all files from Git tree
					// This removes all files from the branch so only the publish files will be added
					await spawn('git', ['rm', '--cached', '-r', ':/']).catch(
						// Can fail if tree is empty: fatal: pathspec ':/' did not match any files
						() => {},
					);

					await spawn('git', ['add', '-f', ...publishFiles]);

					const { stdout: trackedFiles } = await gitStatusTracked();
					if (trackedFiles.length === 0) {
						console.warn('⚠️  No new changes found to commit.');
					} else {
						// -a is passed in so it can stage deletions from `git restore`
						await spawn('git', ['commit', '--no-verify', '-am', `Published branch ${stringify(currentBranch)}`]);
					}

					commitSha = await getCurrentCommit();
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
							`${localTemporaryBranch}:${publishBranch}`,
						]);
						success = true;
					},
				);

				if (!dry) {
					push.clear();
				}
			} finally {
				const revertBranch = await task(`Switching branch back to ${stringify(currentBranch)}`, async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					// In case commit failed and there are uncommitted changes
					await spawn('git', ['reset', '--hard']);

					await spawn('git', ['checkout', '-f', currentBranch]);

					// Delete local branch
					await spawn('git', ['branch', '-D', localTemporaryBranch]).catch(
						// Ignore failures (e.g. in case it didin't even succeed to create this branch)
						() => {},
					);
				});

				revertBranch.clear();
			}

			if (success) {
				const parsedGitUrl = remoteUrl.match(/github\.com:(.+)\.git$/);
				if (parsedGitUrl) {
					const [, repo] = parsedGitUrl;
					setTitle(`Successfully published branch: ${terminalLink(`${cyan(publishBranch)} ${dim(`(${commitSha!})`)}`, `https://github.com/${repo}/tree/${publishBranch}`)}`);

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
