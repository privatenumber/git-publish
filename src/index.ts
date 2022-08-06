import fs from 'fs';
import { execa } from 'execa';
import task from 'tasuku';
import { cli } from 'cleye';
import packlist from 'npm-packlist';
import { name, version, description } from '../package.json';
import { assertCleanTree, getCurrentBranchOrTagName, readJson } from './utils';

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

			// In the try-finally block in case it modifies the working tree
			// On failure, they will be reverted by the hard reset
			try {
				let publishFiles: string[] = [];

				const runHooks = await task('Running hooks', async ({ setWarning, setTitle }) => {
					if (dry) {
						setWarning('');
						return;
					}

					setTitle('Running hook "prepare"');
					await execa('npm', ['run', '--if-present', 'prepare']);

					setTitle('Running hook "prepack"');
					await execa('npm', ['run', '--if-present', 'prepack']);
				});

				if (!dry) {
					runHooks.clear();
				}

				const getPublishFiles = await task('Getting publish files', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					publishFiles = await packlist();

					if (publishFiles.length === 0) {
						throw new Error('No publish files found');
					}
				});

				if (!dry) {
					getPublishFiles.clear();
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

				const checkoutBranch = await task(`Checking out branch ${stringify(publishBranch)}`, async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await execa('git', ['checkout', '--orphan', localTemporaryBranch]);

					// Unstage all files
					await execa('git', ['reset']);
				});

				if (!dry) {
					checkoutBranch.clear();
				}

				const commit = await task('Commiting publish assets', async ({ setWarning }) => {
					if (dry) {
						setWarning('');
						return;
					}

					await execa('git', ['add', '-f', ...publishFiles]);
					await execa('git', ['commit', '-nm', `Published branch ${stringify(currentBranch)}`]);
				});

				if (!dry) {
					commit.clear();
				}

				const push = await task(
					`Force pushing branch ${stringify(publishBranch)} to remote ${stringify(remote)}`,
					async ({ setWarning }) => {
						if (dry) {
							setWarning('');
							return;
						}

						await execa('git', ['push', '-f', remote, `${localTemporaryBranch}:${publishBranch}`]);

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
					await execa('git', ['branch', '-D', localTemporaryBranch]);
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

	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(1);
});
