import fs from 'fs';
import { execa } from 'execa';
import task from 'tasuku';
import { cli } from 'cleye';
import packlist from 'npm-packlist';
import { name, version, description } from '../package.json';
import {
	assertCleanTree, getCurrentBranchOrTagName, readJson, gitStatusTracked,
} from './utils';

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

	await fs.promises.access(packageJsonPath).catch(() => {
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
			try {
				await execa('git', ['remote', 'get-url', remote]);
			} catch {
				throw new Error(`Git remote ${stringify(remote)} does not exist`);
			}

			// In the try-finally block in case it modifies the working tree
			// On failure, they will be reverted by the hard reset
			try {
				const checkoutBranch = await task('Checking out branch', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					if (fresh) {
						await execa('git', ['checkout', '--orphan', localTemporaryBranch]);
					} else {
						const gitFetch = await execa('git', ['fetch', '--depth=1', remote, `${publishBranch}:${localTemporaryBranch}`], {
							reject: false,
						});

						await execa('git', [
							'checkout',
							...(gitFetch.failed ? ['-b'] : []),
							localTemporaryBranch,
						]);
					}

					// Checkout the files tree from the previous branch
					// This also applies any file deletions from the source branch
					await execa('git', ['restore', '--source', currentBranch, ':/']);
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
					const a = await execa('npm', ['run', '--if-present', 'prepare']);
					console.log('a', a);

					setTitle('Running hook "prepack"');
					const b = await execa('npm', ['run', '--if-present', 'prepack']);
					console.log('b', b);
				});

				if (!dry) {
					runHooks.clear();
				}

				const removeHooks = await task('Removing "prepare" & "prepack" hooks', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					// Re-read incase hooks modified the package.json
					const packageJson = await readJson(packageJsonPath);
					if (!('scripts' in packageJson)) {
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
						await fs.promises.writeFile(
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

					const publishFiles = await packlist();
					console.log({
						publishFiles,
					});
					if (publishFiles.length === 0) {
						throw new Error('No publish files found');
					}

					// Remove all files from Git tree
					// This removes all files from the branch so only the publish files will be added
					await execa('git', ['rm', '--cached', '-r', ':/'], {
						// Can fail if tree is empty: fatal: pathspec ':/' did not match any files
						reject: false,
					});

					await execa('git', ['add', '-f', ...publishFiles]);

					const { stdout: trackedFiles } = await gitStatusTracked();
					console.log({ trackedFiles });
					if (trackedFiles.length === 0) {
						console.warn('⚠️  No new changes found to commit.');
					} else {
						// -a is passed in so it can stage deletions from `git restore`
						await execa('git', ['commit', '--no-verify', '-am', `Published branch ${stringify(currentBranch)}`]);
					}
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

						await execa('git', [
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
					await execa('git', ['reset', '--hard']);

					await execa('git', ['checkout', '-f', currentBranch]);

					// Delete local branch
					await execa('git', ['branch', '-D', localTemporaryBranch], {
						// Ignore failures (e.g. in case it didin't even succeed to create this branch)
						reject: false,
					});
				});

				revertBranch.clear();
			}

			if (success) {
				let remoteUrl = remote;

				// If the "remote" flag contains an alias, resolve it to a URL
				try {
					const { stdout } = await execa('git', ['remote', 'get-url', remoteUrl]);
					remoteUrl = stdout.trim();
				} catch {}

				const parsedGitUrl = remoteUrl.match(/github\.com:(.+)\.git$/);

				if (parsedGitUrl) {
					const [, repo] = parsedGitUrl;
					setTitle('Successfully published branch! Install with command:');
					setOutput(`npm i '${repo}#${publishBranch}'`);
				}
			}
		},
	);
})().catch((error) => {
	console.error('Error:', error.message);

	process.exit(1);
});
