import path from 'node:path';
import fs from 'node:fs/promises';
import spawn from 'nano-spawn';
import { cli } from 'cleye';
import type { PackageJson } from '@npmcli/package-json';
import { dim } from 'ansis';
import terminalLink from 'terminal-link';
import packageMeta from '../package.json' with { type: 'json' };
import task from './utils/task.ts';
import { getStdout } from './utils/get-stdout.ts';
import {
	assertCleanTree, getCurrentSourceName, getCurrentCommit,
	getCurrentCommitId,
} from './utils/git.ts';
import { readJson } from './utils/read-json.ts';
import { detectPackageManager } from './utils/detect-package-manager.ts';
import { getGitHubInstallSpecifier, getGitHubRepositoryName } from './utils/github.ts';
import { isHostedGitRemote } from './utils/hosted-git.ts';
import { shellQuote } from './utils/shell-quote.ts';
import { redactRemote } from './utils/redact-remote.ts';
import { getPublishRemote } from './publish-repository/remote.ts';
import { renderPackageBranch } from './package-publication/branch.ts';
import { assertAtomicPackagePublicationDestination } from './package-publication/push.ts';
import { planWorkspacePublication, type WorkspacePublicationPlan } from './workspace-publication/plan.ts';
import { publishWorkspaceClosure } from './workspace-publication/publish.ts';
import { createWorkspaceResult, formatWorkspaceResult } from './workspace-publication/output.ts';
import { publishStandalonePackage } from './standalone-publication/publish.ts';
import { toInstallSpecifier } from './package-publication/prepare.ts';

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
		parameters: ['[packages...]'],
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
	await assertCleanTree();

	const cwd = process.cwd();
	const gitRootPath = await getStdout(spawn('git', ['rev-parse', '--show-toplevel']));
	const sourceName = await getCurrentSourceName();
	const sourceCommit = await getCurrentCommit();
	const packageJsonPath = 'package.json';

	try {
		await fs.access(packageJsonPath);
	} catch {
		throw new Error('No package.json found in current working directory.');
	}

	const packageJson = await readJson(packageJsonPath) as PackageJson;

	const {
		branch, remote, fresh, dry,
	} = argv.flags;
	const sourceCommitId = branch?.includes('{gitSha}') || argv.flags.json
		? await getCurrentCommitId()
		: undefined;
	const packageManager = await detectPackageManager(cwd, gitRootPath);
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
	let installSpecifier: string | undefined;

	if (closurePlan) {
		const publishRemote = await getPublishRemote(gitRootPath, remote, usedDefaultRemote);
		const remoteUrl = publishRemote.installUrl;
		if (closurePlan.nodes.length > 1) {
			assertAtomicPackagePublicationDestination(publishRemote.pushUrls);
		}

		if (dry) {
			console.log(formatWorkspacePublicationPlan(closurePlan, sourceName));
		}
		const peerDiagnostics = formatWorkspacePeerDiagnostics(closurePlan);
		if (peerDiagnostics) {
			console.warn(peerDiagnostics);
		}

		const rootsDescription = closurePlan.roots.map(root => stringify(root)).join(', ');
		const workspacePublish = await task(
			`Publishing ${rootsDescription} from ${stringify(sourceName)}`,
			async ({
				setTitle, setStatus,
			}) => {
				if (dry) {
					setStatus('Dry run');
					return;
				}

				const preparationsByName = await publishWorkspaceClosure({
					plan: closurePlan,
					packageManager,
					repositoryPath: gitRootPath,
					publishRemote,
					sourceName,
					sourceCommit: sourceCommit ?? undefined,
					fresh,
				});

				setTitle(`Published ${rootsDescription} from ${stringify(sourceName)}`);
				return preparationsByName;
			},
		).catch(() => {
			// Any failure here is already rendered within the task tree above
			// (including the pack subprocess output), so exit without re-printing it.
			// Set exitCode (instead of process.exit) so tasuku can flush its final render.
			process.exitCode = 1;
		});
		if (workspacePublish) {
			const result = createWorkspaceResult(
				closurePlan, workspacePublish, sourceName, sourceCommitId,
			);
			if (
				!isHostedGitRemote(remoteUrl)
				&& Object.values(result.installSets).some(set => (
					set.required.length + set.optional.length > 1
				))
			) {
				console.warn('Warning: npm ignores commit pins for non-hosted Git URLs when the same package appears at different commits.');
			}
			if (argv.flags.json) {
				await fs.writeFile(argv.flags.json, `${stringify(result, null, 2)}\n`);
			}
			const aliases = new Set(Object.values(result.aliases).flatMap(entries => (
				Object.entries(entries).map(([alias, target]) => `${alias}\0${target}`)
			)));
			for (const entry of aliases) {
				const [alias, target] = entry.split('\0');
				console.warn(`Warning: npm 12 needs --allow-git=all for alias ${JSON.stringify(alias)} of ${JSON.stringify(target)}.`);
			}
			console.log(`\n${formatWorkspaceResult(result, closurePlan, packageManager, remoteUrl)}`);
		}
	} else {
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

		const gitSubdirectory = path.relative(gitRootPath, cwd);
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
		const remoteUrl = publishRemote.installUrl;

		const preparation = await task(
			`Publishing source ${stringify(sourceName)} → ${stringify(publishBranch)}`,
			async ({ setStatus, setTitle }) => {
				if (dry) {
					setStatus('Dry run');
				}
				const result = await publishStandalonePackage({
					packageName: packageJson.name!,
					packageManager,
					packagePath: cwd,
					repositoryPath: gitRootPath,
					gitSubdirectory,
					publishBranch,
					publishRemote,
					remoteName: remote,
					sourceName,
					sourceCommit: sourceCommit ?? undefined,
					fresh,
					dry,
				});
				const repositoryName = getGitHubRepositoryName(remoteUrl);
				if (result && repositoryName) {
					const branchLink = terminalLink(
						publishBranch,
						`https://github.com/${repositoryName}/tree/${publishBranch}`,
						{ fallback: false },
					);
					const commitLink = terminalLink(
						result.publication.commit.slice(0, 7),
						`https://github.com/${repositoryName}/commit/${result.publication.commit}`,
						{ fallback: false },
					);
					setTitle(`Successfully published branch: ${branchLink} ${dim(`(${commitLink})`)}`);
				}
				return result;
			},
		).catch(() => {
			process.exitCode = 1;
		});
		if (preparation) {
			installSpecifier = getGitHubInstallSpecifier(remoteUrl, publishBranch)
				?? toInstallSpecifier(remoteUrl, publishBranch);
			if (argv.flags.json) {
				await fs.writeFile(argv.flags.json, `${stringify({
					source: {
						ref: sourceName,
						commit: sourceCommitId ?? null,
					},
					packages: [{
						name: preparation.publication.packageName,
						branch: preparation.publication.branch,
						commit: preparation.publication.commit,
						installSpecifier: preparation.publication.installSpecifier,
						role: 'root',
						reused: preparation.reusedExistingCommit,
					}],
					installSets: {
						[preparation.publication.packageName]: {
							required: [preparation.publication.packageName],
							optional: [],
						},
					},
					aliases: { [preparation.publication.packageName]: {} },
				}, null, 2)}\n`);
			}
		}
	}
	if (installSpecifier) {
		const installCommand = packageManager === 'yarn'
			? `yarn add ${shellQuote(`${packageJson.name}@${installSpecifier}`)}`
			: `${packageManager} i ${shellQuote(installSpecifier)}`;
		console.log(`\n→ Install command\n  ${installCommand}`);
		if (packageManager === 'yarn') {
			console.log('  Yarn 4: add the repository to approvedGitRepositories in .yarnrc.yml');
		} else if (packageManager === 'npm') {
			console.log('  npm 12+: add --allow-git=root');
		}
	}
})().catch((error) => {
	console.error('Error:', redactRemote(error.message));
	process.exit(1);
});
