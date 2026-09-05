import path from 'node:path';
import fs from 'node:fs/promises';
import spawn from 'nano-spawn';
import { cli } from 'cleye';
import type { PackageJson } from '@npmcli/package-json';
import { cyan, dim } from 'kolorist';
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
import { getPublishRemote } from './publish-repository/remote.ts';
import { renderPackageBranch } from './package-publication/branch.ts';
import { assertAtomicPackagePublicationDestination } from './package-publication/push.ts';
import { planWorkspacePublication, type WorkspacePublicationPlan } from './workspace-publication/plan.ts';
import { publishWorkspaceClosure } from './workspace-publication/publish.ts';
import { publishStandalonePackage } from './standalone-publication/publish.ts';

const { stringify } = JSON;

const formatWorkspacePublicationPlan = (
	plan: WorkspacePublicationPlan,
	sourceName: string,
): string => {
	const lines = [`Publishing packages for ${JSON.stringify(plan.selected)} from ${JSON.stringify(sourceName)}:`];
	const nodesByName = new Map(plan.nodes.map(node => [node.key, node]));
	for (const node of plan.nodes) {
		const rewrites = node.dependencies.map(edge => `${edge.key} → ${nodesByName.get(edge.target)!.branch}`).join(', ');
		lines.push(`- ${node.key} → ${node.branch}${rewrites ? ` (dependencies: ${rewrites})` : ''}`);
	}
	return lines.join('\n');
};

const formatWorkspacePeerDiagnostics = (plan: WorkspacePublicationPlan): string | undefined => {
	if (plan.peers.length === 0) {
		return undefined;
	}
	const lines = ['Internal workspace peer dependencies are not published. Consumers must provide them:'];
	for (const peer of plan.peers) {
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

	const {
		branch, remote, fresh, dry,
	} = argv.flags;
	const sourceCommitId = branch?.includes('{gitSha}')
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
	});
	let installSpecifier: string | undefined;

	if (closurePlan) {
		const publishRemote = await getPublishRemote(gitRootPath, remote, usedDefaultRemote);
		const remoteUrl = publishRemote.fetchUrl;
		assertAtomicPackagePublicationDestination(publishRemote.pushUrls);

		if (dry) {
			console.log(formatWorkspacePublicationPlan(closurePlan, sourceName));
		}
		const peerDiagnostics = formatWorkspacePeerDiagnostics(closurePlan);
		if (peerDiagnostics) {
			console.warn(peerDiagnostics);
		}

		const workspacePublish = await task(
			`Publishing ${stringify(closurePlan.selected)} from ${stringify(sourceName)}`,
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

				const selected = preparationsByName.get(closurePlan.selected)!;
				const repositoryName = getGitHubRepositoryName(remoteUrl);
				if (repositoryName) {
					const successLink = terminalLink(
						`${cyan(selected.publication.branch)} ${dim(`(${selected.publication.commit})`)}`,
						`https://github.com/${repositoryName}/tree/${selected.publication.branch!}`,
					);
					setTitle(`Published ${stringify(closurePlan.selected)} from ${stringify(sourceName)}: ${successLink}`);
				} else {
					setTitle(`Published ${stringify(closurePlan.selected)} from ${stringify(sourceName)}`);
				}

				return selected;
			},
		).catch(() => {
			// Any failure here is already rendered within the task tree above
			// (including the pack subprocess output), so exit without re-printing it.
			// Set exitCode (instead of process.exit) so tasuku can flush its final render.
			process.exitCode = 1;
		});
		const selected = workspacePublish;
		if (selected) {
			installSpecifier = getGitHubInstallSpecifier(remoteUrl, selected.publication.commit)
				?? selected.publication.installSpecifier;
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
		const remoteUrl = publishRemote.fetchUrl;

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
					setTitle(`Successfully published branch: ${terminalLink(
						`${publishBranch} ${dim(`(${result.publication.commit})`)}`,
						`https://github.com/${repositoryName}/tree/${publishBranch}`,
					)}`);
				}
				return result;
			},
		).catch(() => {
			process.exitCode = 1;
		});
		if (preparation && getGitHubRepositoryName(remoteUrl)) {
			installSpecifier = getGitHubInstallSpecifier(remoteUrl, publishBranch);
		}
	}
	if (installSpecifier) {
		console.log(`\n→ Install command\n  ${packageManager} i '${installSpecifier}'`);
	}
})().catch((error) => {
	console.error('Error:', error.message);
	process.exit(1);
});
