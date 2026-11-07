import path from 'node:path';
import fs from 'node:fs/promises';
import spawn from 'nano-spawn';
import micromatch from 'micromatch';
import yaml from 'js-yaml';
import type { PackageJson } from '@npmcli/package-json';
import { renderPackageBranch } from '../package-publication/branch.ts';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getStdout } from '../utils/get-stdout.ts';
import {
	createPublishGraph, findWorkspacePackageDirectory, type PublishGraphNode, type WorkspacePeer,
} from './graph.ts';
import { findWorkspacePackages, type WorkspacePackage } from './discover.ts';

export type WorkspacePublicationNode = PublishGraphNode & {
	branch: string;
};

export type WorkspacePublicationPlan = {
	roots: string[];
	publishAll: boolean;
	nodes: WorkspacePublicationNode[];
	peers: WorkspacePeer[];
	standalone?: boolean;
};

export const planStandalonePublication = async ({
	cwd, gitRootPath, packageJson, sourceName, sourceCommitId, publishBranch,
}: {
	cwd: string;
	gitRootPath: string;
	packageJson: PackageJson;
	sourceName: string;
	sourceCommitId: string | undefined;
	publishBranch: string | undefined;
}): Promise<WorkspacePublicationPlan> => {
	const workspaceDependencies: string[] = [];
	for (const field of ['dependencies', 'optionalDependencies'] as const) {
		for (const [name, specification] of Object.entries(packageJson[field] ?? {})) {
			if (specification?.startsWith('workspace:')) {
				workspaceDependencies.push(`- ${field}.${name}: ${specification}`);
			}
		}
	}
	if (workspaceDependencies.length > 0) {
		throw new Error(`Cannot publish packages with workspace dependencies:\n${workspaceDependencies.join('\n')}\nPre-bundle these dependencies before publishing.`);
	}
	const name = packageJson.name!;
	const branch = publishBranch
		? renderPackageBranch({
			template: publishBranch,
			gitRef: sourceName,
			gitSha: sourceCommitId,
			packageName: name,
		})
		: `npm/${sourceName}${path.relative(gitRootPath, cwd) ? `-${name}` : ''}`;
	try {
		await getStdout(spawn('git', ['check-ref-format', '--branch', branch]));
	} catch {
		throw new Error(`Invalid publish branch ${JSON.stringify(branch)}.`);
	}
	return {
		standalone: true,
		roots: [name],
		publishAll: false,
		peers: [],
		nodes: [{
			key: name,
			package: {
				name,
				dir: cwd,
				packageJson: packageJson as WorkspacePackage['packageJson'],
			},
			dependencies: [],
			role: 'root',
			branch,
		}],
	};
};

export const planWorkspacePublication = async ({
	cwd,
	gitRootPath,
	sourceName,
	sourceCommitId,
	packageManager,
	publishBranch,
	force,
	selection,
}: {
	cwd: string;
	gitRootPath: string;
	sourceName: string;
	sourceCommitId: string | undefined;
	packageManager: PackageManager;
	publishBranch?: string;
	force: boolean | undefined;
	selection: string[];
}): Promise<WorkspacePublicationPlan | undefined> => {
	const workspace = await findWorkspacePackages(cwd, packageManager, gitRootPath);
	if (!workspace) {
		return undefined;
	}
	const isRoot = path.resolve(cwd) === path.resolve(workspace.rootDirectory);
	const defaultAtRoot = selection.length === 0 && isRoot;
	const publicRoot = defaultAtRoot && Boolean(workspace.rootPackage?.name)
		&& !workspace.rootPackage?.packageJson.private;
	const publishAll = defaultAtRoot && !publicRoot;
	const candidates = [...workspace.packages];
	if (workspace.rootPackage && !candidates.some(candidate => (
		candidate.dir === workspace.rootDirectory
	))) {
		candidates.push(workspace.rootPackage);
	}
	const roots = new Set<string>();
	if (selection.length > 0) {
		for (const argument of selection) {
			const pattern = path.resolve(cwd, argument).split(path.sep).join('/');
			const matches = candidates.filter(candidate => candidate.name === argument
				|| micromatch.isMatch(path.resolve(candidate.dir).split(path.sep).join('/'), pattern));
			if (matches.length === 0) {
				throw new Error(`No workspace package matches ${JSON.stringify(argument)}.`);
			}
			for (const match of matches) {
				roots.add(match.name);
			}
		}
	} else if (publicRoot) {
		roots.add(workspace.rootPackage!.name);
	} else if (publishAll) {
		for (const candidate of workspace.packages) {
			if (
				path.resolve(candidate.dir) !== path.resolve(workspace.rootDirectory)
				&& !candidate.packageJson.private
			) {
				roots.add(candidate.name);
			}
		}
	} else {
		const selectedPackage = findWorkspacePackageDirectory(workspace, cwd);
		if (!selectedPackage) {
			return undefined;
		}
		roots.add(selectedPackage.name);
	}
	if (roots.size === 0) {
		throw new Error('No non-private workspace packages found to publish.');
	}
	const yarnConfig = packageManager === 'yarn'
		? await fs.readFile(path.join(workspace.rootDirectory, '.yarnrc.yml'), 'utf8').catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				return '';
			}
			throw error;
		})
		: '';
	const yarnSettings = yaml.load(yarnConfig) as
		| { enableTransparentWorkspaces?: boolean }
		| undefined;
	const transparentWorkspaces = yarnSettings?.enableTransparentWorkspaces !== false;
	const policy = {
		plainRanges: packageManager !== 'pnpm' && (packageManager !== 'yarn' || transparentWorkspaces),
		plainPeers: packageManager !== 'yarn' || transparentWorkspaces,
	};
	const graph = createPublishGraph({
		...workspace,
		packages: candidates,
	}, [...roots], { policy });
	if (publicRoot && graph.nodes.length === 1 && graph.peers.length === 0) {
		return undefined;
	}
	if (!force) {
		const privatePackage = graph.nodes.find(node => (
			path.resolve(node.package.dir) === path.resolve(workspace.rootDirectory)
			&& node.package.packageJson.private
		));
		if (privatePackage) {
			throw new Error(`Workspace package ${JSON.stringify(privatePackage.key)} is marked as private. Use --force to publish it anyway.`);
		}
	}
	const nodes: WorkspacePublicationNode[] = [];
	const branchTemplate = publishBranch ?? 'npm/{gitRef}-{package}';
	const packagesByBranch = new Map<string, string>();
	for (const node of graph.nodes) {
		const relative = path.relative(gitRootPath, node.package.dir);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Workspace package ${JSON.stringify(node.key)} is outside the Git repository and cannot be published.`);
		}
		const branch = renderPackageBranch({
			template: publicRoot && node.key === workspace.rootPackage!.name && !publishBranch
				? 'npm/{gitRef}'
				: branchTemplate,
			gitRef: sourceName,
			gitSha: sourceCommitId,
			packageName: node.key,
		});
		try {
			await getStdout(spawn('git', ['check-ref-format', '--branch', branch]));
		} catch {
			throw new Error(`Invalid publish branch ${JSON.stringify(branch)}.`);
		}
		const otherPackage = packagesByBranch.get(branch);
		if (otherPackage) {
			throw new Error(`Workspace branch template ${JSON.stringify(branchTemplate)} renders ${JSON.stringify(branch)} for both ${JSON.stringify(otherPackage)} and ${JSON.stringify(node.key)}. Include {package} to publish each package to a unique branch.`);
		}
		packagesByBranch.set(branch, node.key);
		nodes.push({
			...node,
			branch,
		});
	}
	return {
		roots: [...roots],
		publishAll,
		nodes,
		peers: graph.peers,
	};
};
