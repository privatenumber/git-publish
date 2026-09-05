import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import spawn from 'nano-spawn';
import type { PackageJson } from '@npmcli/package-json';
import { getStdout } from '../utils/get-stdout.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { readJson } from '../utils/read-json.ts';
import { packPackage } from '../utils/pack-package.ts';
import { extractTarball, type File } from '../utils/extract-tarball.ts';
import { gitStatusTracked } from '../utils/git.ts';
import {
	createPublishGraph, findWorkspacePackageDirectory, type PublishGraph, type PublishGraphNode,
} from './graph.ts';
import { preparePublishBranch } from './prepare-branch.ts';
import { runDependencyGraph, type GraphNode } from './run-graph.ts';
import { findWorkspacePackages, type Workspace } from './workspace.ts';
import { createPublishRepository, type PublishRepository } from './create.ts';
import type { PublishRemote } from './remote.ts';

const { stringify } = JSON;

export type ClosurePlan = {
	workspace: Workspace;
	graph: PublishGraph;
	branches: Map<string, string>;
};

export type PackagePublication = {
	packageName: string;
	branch: string;
	commit: string;
	installSpecifier: string;
	refspec: string;
};

export type PackagePreparation = {
	publication: PackagePublication;
	files: File[];
};

type ClosureTask = {
	node: PublishGraphNode;
	tarball: string;
	worktree: string;
};

export const planWorkspacePublication = async ({
	cwd,
	gitRootPath,
	sourceName,
	packageManager,
	publishBranch,
}: {
	cwd: string;
	gitRootPath: string;
	sourceName: string;
	packageManager: PackageManager;
	publishBranch?: string;
}): Promise<ClosurePlan | undefined> => {
	const workspace = await findWorkspacePackages(cwd, packageManager);
	if (!workspace) {
		return undefined;
	}
	const selectedPackage = findWorkspacePackageDirectory(workspace, cwd);
	if (!selectedPackage) {
		return undefined;
	}
	const selected = selectedPackage.name;
	const graph = createPublishGraph(workspace, selected);
	const branches = new Map<string, string>();
	const branchesByName = new Set<string>();
	const selectedBranch = publishBranch ?? `npm/${sourceName}-${selected}`;
	for (const node of graph.nodes) {
		const relative = path.relative(gitRootPath, node.package.dir);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Workspace package ${JSON.stringify(node.key)} is outside the Git repository and cannot be published.`);
		}
		const branch = node.key === selected ? selectedBranch : `${selectedBranch}-${node.key}`;
		if (branchesByName.has(branch)) {
			throw new Error(`Publish branch ${JSON.stringify(branch)} is assigned to more than one workspace package.`);
		}
		try {
			await getStdout(spawn('git', ['check-ref-format', '--branch', branch]));
		} catch {
			throw new Error(`Invalid publish branch ${JSON.stringify(branch)}.`);
		}
		branchesByName.add(branch);
		branches.set(node.key, branch);
	}
	return {
		workspace,
		graph,
		branches,
	};
};

export const packClosurePackages = async ({
	plan,
	packageManager,
	repository,
	gitRootPath,
}: {
	plan: ClosurePlan;
	packageManager: PackageManager;
	repository: PublishRepository;
	gitRootPath: string;
}): Promise<Map<string, string>> => {
	const tarballs = new Map<string, string>();
	for (const [index, node] of plan.graph.nodes.entries()) {
		const tarball = await packPackage(
			packageManager,
			repository.packWorktreePath,
			path.join(repository.packTemporaryDirectory, String(index)),
			node.package.dir,
			gitRootPath,
			path.relative(gitRootPath, node.package.dir),
		);
		tarballs.set(node.key, tarball);
	}
	return tarballs;
};

const toPackageManagerGitUrl = (url: string) => {
	if (url.startsWith('git+')) {
		return url;
	}
	if (/^(?:file|git|https?|ssh):\/\//.test(url)) {
		return `git+${url}`;
	}
	const scpUrl = /^(?<user>[^@/:]+@)?(?<host>[^/:]+):(?<path>.+)$/.exec(url)?.groups;
	if (scpUrl) {
		return `git+ssh://${scpUrl.user ?? ''}${scpUrl.host}/${scpUrl.path}`;
	}
	return `git+file://${path.resolve(url)}`;
};

export const toInstallSpecifier = (fetchUrl: string, commit: string) => `${toPackageManagerGitUrl(fetchUrl)}#${commit}`;

export const prepareClosureBranches = async ({
	plan,
	repository,
	fresh,
}: {
	plan: ClosurePlan;
	repository: PublishRepository;
	fresh: boolean | undefined;
}): Promise<Map<string, string>> => {
	const worktrees = new Map<string, string>();
	plan.graph.nodes.forEach((node, index) => {
		worktrees.set(node.key, path.join(repository.temporaryDirectory, `publish-worktree-${index}`));
	});
	for (const node of plan.graph.nodes) {
		await preparePublishBranch({
			repository,
			publishBranch: plan.branches.get(node.key)!,
			localBranch: `git-publish-${randomBytes(16).toString('hex')}`,
			fresh,
			worktreePath: worktrees.get(node.key)!,
		});
	}
	return worktrees;
};

export const commitClosureSnapshots = async ({
	plan,
	repository,
	tarballs,
	worktrees,
	sourceName,
	sourceCommit,
	fetchUrl,
}: {
	plan: ClosurePlan;
	repository: PublishRepository;
	tarballs: Map<string, string>;
	worktrees: Map<string, string>;
	sourceName: string;
	sourceCommit: string | undefined;
	fetchUrl: string;
}): Promise<PackagePreparation[]> => {
	const adapted: GraphNode<string, ClosureTask>[] = plan.graph.nodes.map(node => ({
		key: node.key,
		value: {
			node,
			tarball: tarballs.get(node.key)!,
			worktree: worktrees.get(node.key)!,
		} satisfies ClosureTask,
		dependencies: node.dependencies.map(edge => edge.target),
	}));
	const results = await runDependencyGraph(adapted, async (
		{ key, value },
		dependencyResults,
	): Promise<PackagePreparation> => {
		const worktreeOptions = {
			cwd: value.worktree,
			env: repository.gitOptions.env,
		};
		const files = await extractTarball(value.tarball, value.worktree);
		const manifestPath = path.join(value.worktree, 'package.json');
		const manifest = await readJson(manifestPath) as PackageJson;
		const original = stringify(manifest);
		for (const edge of value.node.dependencies) {
			const dependency = dependencyResults.get(edge.target)!;
			const field = manifest[edge.field] ?? {};
			field[edge.key] = dependency.publication.installSpecifier;
			manifest[edge.field] = field;
		}
		const { scripts } = manifest;
		if (scripts && ('prepare' in scripts || 'prepack' in scripts)) {
			delete scripts.prepare;
			delete scripts.prepack;
		}
		if (stringify(manifest) !== original) {
			await fs.writeFile(manifestPath, stringify(manifest, null, 2));
		}
		await spawn('git', ['add', '--all'], worktreeOptions);
		const tracked = await gitStatusTracked(worktreeOptions);
		let commit: string;
		if (tracked.length === 0) {
			console.warn(`⚠️  No new changes found for ${key}, keeping the existing publish branch.`);
			commit = await getStdout(spawn('git', ['rev-parse', 'HEAD'], worktreeOptions));
		} else {
			let commitMessage = `Published ${JSON.stringify(key)} from ${JSON.stringify(sourceName)}`;
			if (sourceCommit) {
				commitMessage += ` (${sourceCommit})`;
			}
			await spawn('git', [
				'-c',
				'user.name=git-publish',
				'-c',
				'user.email=bot@git-publish',
				'commit',
				'--no-verify',
				'-m',
				commitMessage,
				'--author=git-publish <bot@git-publish>',
			], worktreeOptions);
			commit = await getStdout(spawn('git', ['rev-parse', 'HEAD'], worktreeOptions));
		}
		const branch = plan.branches.get(key)!;
		const installSpecifier = toInstallSpecifier(fetchUrl, commit);
		return {
			publication: {
				packageName: key,
				branch,
				commit,
				installSpecifier,
				refspec: `${commit}:refs/heads/${branch}`,
			},
			files,
		};
	});
	return plan.graph.nodes.map(node => results.get(node.key)!);
};

export const readRemoteTips = async (
	repository: PublishRepository,
): Promise<Map<string, string>> => {
	const output = await getStdout(spawn('git', ['ls-remote', repository.fetchRemoteName], repository.gitOptions));
	const tips = new Map<string, string>();
	for (const line of output.split('\n')) {
		const separator = line.indexOf('\t');
		if (separator === -1) {
			continue;
		}
		const sha = line.slice(0, separator);
		const ref = line.slice(separator + 1);
		if (ref.startsWith('refs/heads/')) {
			tips.set(ref.slice('refs/heads/'.length), sha);
		}
	}
	return tips;
};

export const pushClosureReferences = async ({
	repository,
	preparations,
	fresh,
	remoteTips,
}: {
	repository: PublishRepository;
	preparations: PackagePreparation[];
	fresh: boolean | undefined;
	remoteTips?: Map<string, string>;
}): Promise<void> => {
	const [pushRemoteName] = repository.pushRemoteNames;
	const args = ['push', '--atomic'];
	if (fresh) {
		for (const { publication } of preparations) {
			args.push(`--force-with-lease=refs/heads/${publication.branch}:${remoteTips?.get(publication.branch) ?? ''}`);
		}
	}
	args.push('--no-verify', pushRemoteName!, ...preparations.map(preparation => preparation.publication.refspec));
	await spawn('git', args, repository.gitOptions);
};

export const publishWorkspaceClosure = async ({
	plan,
	packageManager,
	sourceRepositoryPath,
	gitRootPath,
	publishRemote,
	sourceName,
	sourceCommit,
	fresh,
}: {
	plan: ClosurePlan;
	packageManager: PackageManager;
	sourceRepositoryPath: string;
	gitRootPath: string;
	publishRemote: PublishRemote;
	sourceName: string;
	sourceCommit: string | undefined;
	fresh: boolean | undefined;
}): Promise<PackagePreparation[]> => {
	const repository = await createPublishRepository({
		sourceRepositoryPath,
		publishRemote,
	});
	let primaryError: unknown;
	try {
		const remoteTips = fresh ? await readRemoteTips(repository) : undefined;
		const worktrees = await prepareClosureBranches({
			plan,
			repository,
			fresh,
		});
		const tarballs = await packClosurePackages({
			plan,
			packageManager,
			repository,
			gitRootPath,
		});
		const preparations = await commitClosureSnapshots({
			plan,
			repository,
			tarballs,
			worktrees,
			sourceName,
			sourceCommit,
			fetchUrl: publishRemote.fetchUrl,
		});
		await pushClosureReferences({
			repository,
			preparations,
			fresh,
			remoteTips,
		});
		return preparations;
	} catch (error) {
		primaryError = error;
		throw error;
	} finally {
		await repository.dispose().catch((cleanupError: unknown) => {
			if (primaryError) {
				throw new AggregateError([primaryError, cleanupError], 'Failed to publish workspace closure.');
			}
			throw cleanupError;
		});
	}
};

export const formatClosurePlan = (plan: ClosurePlan, sourceName: string): string => {
	const lines = [`Publishing workspace closure from ${JSON.stringify(sourceName)}:`];
	for (const node of plan.graph.nodes) {
		const branch = plan.branches.get(node.key)!;
		const rewrites = node.dependencies.map(edge => `${edge.key} → ${plan.branches.get(edge.target)!}`).join(', ');
		lines.push(`- ${node.key} → ${branch}${rewrites ? ` (dependencies: ${rewrites})` : ''}`);
	}
	return lines.join('\n');
};

export const formatWorkspacePeerDiagnostics = (plan: ClosurePlan): string | undefined => {
	if (plan.graph.peers.length === 0) {
		return undefined;
	}
	const lines = ['Internal workspace peer dependencies are not published. Consumers must provide them:'];
	for (const peer of plan.graph.peers) {
		const target = peer.target
			? ` resolves to ${JSON.stringify(peer.target)}`
			: ' does not resolve to a workspace package';
		lines.push(`- ${JSON.stringify(peer.from)} declares ${JSON.stringify(peer.key)}: ${JSON.stringify(peer.specification)}${target}.`);
	}
	return lines.join('\n');
};
