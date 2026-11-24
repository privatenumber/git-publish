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
	assertCleanTree, assertSourceUnchanged, getSourceName, getSourceCommit,
} from './utils/git.ts';
import { readJson } from './utils/read-json.ts';
import { detectPackageManager } from './utils/detect-package-manager.ts';
import {
	getGitHubRepositoryName, redactRemote,
} from './utils/git-url.ts';
import { getPublishRemote } from './publish-repository/remote.ts';
import {
	formatSkippedPrivatePackages, planStandalonePublication, planWorkspacePublication,
	type WorkspacePublicationPlan,
} from './workspace-publication/plan.ts';
import { publishWorkspaceClosure } from './workspace-publication/publish.ts';
import { createVersionSha } from './package-publication/version-sha.ts';
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

const runWithSignals = async (run: (signal: AbortSignal) => Promise<void>) => {
	const controller = new AbortController();
	let interrupted = false;
	const interrupt = (code: number) => {
		if (interrupted) { process.exit(code); }
		interrupted = true;
		process.exitCode = code;
		controller.abort(new Error('Publication interrupted.'));
	};
	const onInterrupt = () => interrupt(130);
	const onTerminate = () => interrupt(143);
	process.on('SIGINT', onInterrupt);
	process.on('SIGTERM', onTerminate);
	try {
		await run(controller.signal);
	} finally {
		process.off('SIGINT', onInterrupt);
		process.off('SIGTERM', onTerminate);
	}
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
				description: 'Validate and print the publication plan without packing, committing, or pushing.',
			},
			includePrivate: {
				type: Boolean,
				description: 'At a workspace root without package arguments, also publish members marked as private.',
			},
			versionSha: {
				type: Boolean,
				description: 'Record the source commit in each published package.json: version gets +sha-<commit> build metadata and gitHead the full SHA.',
			},
			json: {
				type: String,
				placeholder: '<path>',
				description: 'Write publication details and install sets to a JSON file.',
			},
		},
		help: {
			description: packageMeta.description,
			// cleye omits root parameters from the generated usage once commands exist
			usage: [
				`  ${packageMeta.name} [flags...] [packages...]`,
				`  ${packageMeta.name} skills [flags...]`,
			],
			examples: [
				'  # Publish the current package to the branch npm/<current branch>',
				`  ${packageMeta.name}`,
				'',
				'  # Publish selected workspace packages and their workspace dependencies',
				`  ${packageMeta.name} @acme/core @acme/cli`,
				'',
				'  # Print the publication plan without packing or pushing',
				`  ${packageMeta.name} --dry`,
				'',
				'  # Replace the branch history with one commit',
				`  ${packageMeta.name} --fresh`,
				'',
				'  # Write publication details and install commands to a JSON file',
				`  ${packageMeta.name} --json publication.json`,
			],
		},
	});
	if (argv.command) {
		await argv.runCommand();
		return;
	}
	await assertCleanTree();

	const { ref, commit } = await getSourceCommit();
	const shortCommit = await getStdout(spawn('git', ['rev-parse', '--short', commit]));
	const cwd = process.cwd();
	const gitRootPath = await getStdout(spawn('git', ['rev-parse', '--show-toplevel']));
	const source = {
		ref,
		commit,
		shortCommit,
		name: await getSourceName(ref, commit, shortCommit),
	};
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
	const packageManager = await detectPackageManager(cwd, gitRootPath);
	const closurePlan = await planWorkspacePublication({
		cwd,
		gitRootPath,
		sourceName: source.name,
		sourceCommitId: source.commit,
		packageManager,
		publishBranch: branch,
		includePrivate: argv.flags.includePrivate,
		selection: argv._.packages,
	});
	if (closurePlan.kind === 'standalone' && argv._.packages.length > 0) {
		throw new Error('Package selection requires a workspace.');
	}
	const plan = closurePlan.kind === 'workspace'
		? closurePlan
		: await planStandalonePublication({
			cwd,
			gitRootPath,
			packageJson,
			sourceName: source.name,
			sourceCommitId: source.commit,
			publishBranch: branch,
		});
	await assertSourceUnchanged(source);
	const publishRemote = await getPublishRemote(gitRootPath, remote, usedDefaultRemote);
	const remoteUrl = publishRemote.installUrl;
	const pushMode = fresh ? 'lease' : 'normal';
	// Built before the dry-run return so a dry run rejects invalid versions too
	const versionShas = new Map(argv.flags.versionSha
		? plan.nodes.map(node => [node.key, createVersionSha(
			node.key,
			node.package.packageJson.version,
			source.commit,
			source.shortCommit,
		)])
		: []);
	if (closurePlan.kind === 'workspace') {
		const { skippedPrivatePackages } = closurePlan;
		if (skippedPrivatePackages.length > 0) {
			console.log(formatSkippedPrivatePackages(skippedPrivatePackages));
		}
		if (dry) {
			console.log(formatWorkspacePublicationPlan(closurePlan, source.name));
		}
	}
	const peerDiagnostics = formatWorkspacePeerDiagnostics(plan);
	if (peerDiagnostics) {
		console.warn(peerDiagnostics);
	}
	const rootsDescription = plan.roots.map(root => stringify(root)).join(', ');
	const publishBranch = plan.nodes[0]!.branch;
	const publicationTitle = plan.kind === 'standalone'
		? `Publishing source ${stringify(source.name)} → ${stringify(publishBranch)}`
		: `Publishing ${rootsDescription} from ${stringify(source.name)}`;
	if (dry) {
		await task(publicationTitle, async ({ setStatus }) => {
			setStatus('Dry run');
			const branches = plan.kind === 'standalone'
				? `branch ${stringify(publishBranch)}`
				: `${plan.nodes.length} ${plan.nodes.length === 1 ? 'branch' : 'branches'}`;
			console.log(`Would push ${branches} to remote ${stringify(redactRemote(remote))}`);
		});
		return;
	}
	await runWithSignals(async (signal) => {
		const publication = await task(
			publicationTitle,
			async ({ setTitle }) => {
				const prepared = await publishWorkspaceClosure({
					plan,
					packageManager,
					repositoryPath: gitRootPath,
					publishRemote,
					pushMode,
					source,
					versionShas,
				}, signal);
				if (plan.kind === 'standalone') {
					const publishedCommit = prepared.preparations.get(plan.nodes[0]!.key)!.publication.commit;
					const publishedShortCommit = publishedCommit.slice(0, 7);
					const repositoryName = getGitHubRepositoryName(remoteUrl);
					const branchLink = repositoryName
						? terminalLink(publishBranch, `https://github.com/${repositoryName}/tree/${publishBranch}`, { fallback: false })
						: publishBranch;
					const commitLink = repositoryName
						? terminalLink(publishedShortCommit, `https://github.com/${repositoryName}/commit/${publishedCommit}`, { fallback: false })
						: publishedShortCommit;
					setTitle(`Successfully published branch: ${branchLink} ${dim(`(${commitLink})`)}`);
				} else {
					setTitle(`Published ${rootsDescription} from ${stringify(source.name)}`);
				}
				return prepared;
			},
		).catch(() => {
			process.exitCode ||= 1;
		});
		if (publication) {
			const result = createWorkspaceResult({
				plan: publication.plan,
				preparations: publication.preparations,
				ref: source.name,
				commit: source.commit,
				packageManager,
				fetchUrl: remoteUrl,
			});
			const { presentation: _presentation, ...jsonResult } = result;
			const json = `${stringify(jsonResult, null, 2)}\n`;
			let jsonWriteError: Error | undefined;
			if (argv.flags.json) {
				// Write before printing so a closed stdout cannot prevent the file write
				await fs.writeFile(argv.flags.json, json).catch((error: Error) => {
					jsonWriteError = error;
				});
			}
			console.log(`\n${formatWorkspaceResult(result)}`);
			if (jsonWriteError) {
				console.error(`Publication succeeded, but could not write JSON file ${stringify(argv.flags.json)}: ${redactRemote(jsonWriteError.message)}. Publication details follow:`);
				console.error(json.trimEnd());
				process.exitCode ||= 1;
			}
		}
	});
})().catch((error) => {
	console.error('Error:', redactRemote(error.message));
	process.exitCode ||= 1;
});
