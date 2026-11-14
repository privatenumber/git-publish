import fs from 'node:fs/promises';
import path from 'node:path';
import spawn from 'nano-spawn';
import { cli } from 'cleye';
import type { PackageJson } from '@npmcli/package-json';
import { dim } from 'ansis';
import terminalLink from 'terminal-link';
import packageMeta from '../package.json' with { type: 'json' };
import task from './utils/task.ts';
import { getStdout } from './utils/get-stdout.ts';
import {
	assertCleanTree, getCurrentSourceName, getSourceCommit,
} from './utils/git.ts';
import { readJson } from './utils/read-json.ts';
import { detectPackageManager } from './utils/detect-package-manager.ts';
import {
	getGitHubRepositoryName, isHostedGitRemote, redactRemote,
} from './utils/git-url.ts';
import { getPublishRemote } from './publish-repository/remote.ts';
import { createPublishRepository, configurePublishRemotes } from './publish-repository/create.ts';
import { getErrorDetails } from './utils/error.ts';
import { assertAtomicPackagePublicationDestination } from './package-publication/push.ts';
import { planStandalonePublication, planWorkspacePublication, type WorkspacePublicationPlan } from './workspace-publication/plan.ts';
import { publishWorkspaceClosure } from './workspace-publication/publish.ts';
import {
	createWorkspaceResult, formatWorkspaceResult,
} from './workspace-publication/output.ts';

const { stringify } = JSON;

const formatWorkspacePublicationPlan = (
	plan: WorkspacePublicationPlan,
	sourceName: string,
): string => {
	const lines = [`Publishing packages for ${plan.roots.map(name => JSON.stringify(name)).join(', ')} from ${JSON.stringify(sourceName)}:`];
	const nodesByName = new Map(plan.nodes.map(node => [node.key, node]));
	for (const node of plan.nodes) {
		const rewrites = node.dependencies.map(edge => `${edge.key} → ${nodesByName.get(edge.target)!.branch}`).join(', ');
		lines.push(`- ${node.key}${node.package.packageJson.private ? ' (private)' : ''} → ${node.branch}${rewrites ? ` (dependencies: ${rewrites})` : ''}`);
	}
	return lines.join('\n');
};

const formatWorkspacePeerDiagnostics = (plan: WorkspacePublicationPlan): string | undefined => {
	const unresolvedPeers = plan.peers.filter(peer => !peer.target);
	if (unresolvedPeers.length === 0) {
		return undefined;
	}
	const lines = ['Workspace peer dependencies could not be resolved. Consumers must provide them:'];
	for (const peer of unresolvedPeers) {
		lines.push(`- ${JSON.stringify(peer.from)} declares ${JSON.stringify(peer.key)}: ${JSON.stringify(peer.specification)} does not resolve to a workspace package.`);
	}
	return lines.join('\n');
};

(async () => {
	let usedDefaultRemote = false;
	const argv = cli({
		name: packageMeta.name,
		version: packageMeta.version,
		strictFlags: true,
		parameters: ['[packages...]'],
		commands: {
			skills: {
				description: 'Print the bundled agent skill, or install it with --install <directory>',
				loader: () => import('./commands/skills.ts'),
			},
		},
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
				default: {
					value: () => {
						usedDefaultRemote = true;
						return 'origin';
					},
					description: 'origin',
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
				description: 'Allow publishing a private standalone package or a private workspace root.',
			},
			json: {
				type: String,
				placeholder: '<path>',
				description: 'Write publication details and install sets to a JSON file.',
			},
		},
		help: {
			description: packageMeta.description,
		},
	});
	if (argv.command) {
		await argv.runCommand();
		return;
	}
	await assertCleanTree();
	const { ref, commit: sourceCommitId } = await getSourceCommit();
	const sourceCommit = await getStdout(spawn('git', ['rev-parse', '--short', sourceCommitId]));

	const liveCwd = process.cwd();
	const liveGitRootPath = await getStdout(spawn('git', ['rev-parse', '--show-toplevel']));
	const sourceName = await getCurrentSourceName(ref, sourceCommitId, sourceCommit);
	const {
		branch, remote, fresh, dry,
	} = argv.flags;
	const repository = await createPublishRepository({
		sourceRepositoryPath: liveGitRootPath,
		sourceCommitId,
	});
	try {
		const gitRootPath = repository.packWorktreePath;
		const cwd = path.join(gitRootPath, path.relative(liveGitRootPath, liveCwd));
		const packageJsonPath = path.join(cwd, 'package.json');

		try {
			await fs.access(packageJsonPath);
		} catch {
			throw new Error('No package.json found in current working directory.');
		}

		const packageJson = await readJson(packageJsonPath) as PackageJson;

		const packageManager = await detectPackageManager(liveCwd, liveGitRootPath);
		const closurePlan = await planWorkspacePublication({
			cwd,
			gitRootPath,
			sourceName,
			sourceCommitId,
			packageManager,
			publishBranch: branch,
			force: argv.flags.force,
			selection: argv._.packages,
		});
		if (!closurePlan && argv._.packages.length > 0) {
			throw new Error('Package selection requires a workspace.');
		}
		if (!closurePlan && packageJson.private && !argv.flags.force) {
			throw new Error('This package is marked as private. Use --force to publish it anyway.');
		}
		const plan = closurePlan ?? await planStandalonePublication({
			cwd,
			gitRootPath,
			packageJson,
			sourceName,
			sourceCommitId,
			publishBranch: branch,
		});
		const publishRemote = await getPublishRemote(liveGitRootPath, remote, usedDefaultRemote);
		const remoteUrl = publishRemote.installUrl;
		if (plan.nodes.length > 1) {
			assertAtomicPackagePublicationDestination(publishRemote.pushUrls);
		}
		if (dry && !plan.standalone) {
			console.log(formatWorkspacePublicationPlan(plan, sourceName));
		}
		const peerDiagnostics = formatWorkspacePeerDiagnostics(plan);
		if (peerDiagnostics) {
			console.warn(peerDiagnostics);
		}
		const rootsDescription = plan.roots.map(root => stringify(root)).join(', ');
		const publishBranch = plan.nodes[0]!.branch;
		const publication = await task(
			plan.standalone
				? `Publishing source ${stringify(sourceName)} → ${stringify(publishBranch)}`
				: `Publishing ${rootsDescription} from ${stringify(sourceName)}`,
			async ({ setTitle, setStatus }) => {
				if (dry) {
					setStatus('Dry run');
					if (plan.standalone) {
						console.log(`Pushing branch ${stringify(publishBranch)} to remote ${stringify(redactRemote(remote))}`);
					}
					return;
				}
				const configuredRepository = await configurePublishRemotes(repository, publishRemote);
				const prepared = await publishWorkspaceClosure({
					plan,
					repository: configuredRepository,
					packageManager,
					repositoryPath: liveGitRootPath,
					publishRemote,
					sourceName,
					sourceCommit,
					sourceCommitId,
					fresh,
				});
				const repositoryName = plan.standalone && getGitHubRepositoryName(remoteUrl);
				if (repositoryName) {
					const { commit } = prepared.preparations.get(plan.nodes[0]!.key)!.publication;
					const branchLink = terminalLink(publishBranch, `https://github.com/${repositoryName}/tree/${publishBranch}`, { fallback: false });
					const commitLink = terminalLink(commit.slice(0, 7), `https://github.com/${repositoryName}/commit/${commit}`, { fallback: false });
					setTitle(`Successfully published branch: ${branchLink} ${dim(`(${commitLink})`)}`);
				} else if (!plan.standalone) {
					setTitle(`Published ${rootsDescription} from ${stringify(sourceName)}`);
				}
				return prepared;
			},
		).catch(() => {
			process.exitCode = 1;
		});
		if (publication) {
			const result = createWorkspaceResult(
				publication.plan, publication.preparations, sourceName, sourceCommitId,
			);
			const { presentation: _presentation, ...jsonResult } = result;
			const json = `${stringify(jsonResult, null, 2)}\n`;
			let jsonWriteError: Error | undefined;
			if (argv.flags.json) {
				// Write before printing so a closed stdout cannot prevent the file write
				await fs.writeFile(argv.flags.json, json).catch((error: Error) => {
					jsonWriteError = error;
				});
			}
			if (!isHostedGitRemote(remoteUrl) && Object.values(result.installSets).some(set => (
				set.required.length + set.optional.length > 1
			))) {
				console.warn('Warning: npm ignores commit pins for non-hosted Git URLs when the same package appears at different commits.');
			}
			console.log(`\n${formatWorkspaceResult(result, packageManager, remoteUrl)}`);
			if (jsonWriteError) {
				console.error(`Publication succeeded, but could not write JSON file ${stringify(argv.flags.json)}: ${redactRemote(jsonWriteError.message)}. Publication details follow:`);
				console.error(json.trimEnd());
				process.exitCode = 1;
			}
		}
	} finally {
		const cleanup = task('Cleaning up temporary files', async ({ setWarning }) => {
			try {
				await repository.dispose();
			} catch (error) {
				setWarning(getErrorDetails(error));
			}
		});
		await cleanup;
		if (!cleanup.warning) { cleanup.clear(); }
	}
})().catch((error) => {
	console.error('Error:', redactRemote(error.message));
	process.exitCode = 1;
});
