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
import { createInstallGraph } from './install-graph.ts';

export type WorkspacePublicationNode = PublishGraphNode & {
	branch: string;
};

type PlanFields = {
	roots: string[];
	nodes: WorkspacePublicationNode[];
	peers: WorkspacePeer[];
	workspaceDirectories?: string[];
};

type CatalogConfiguration = {
	catalog?: Record<string, string>;
	catalogs?: Record<string, Record<string, string>>;
};

const parseCatalogJson = (output: string, manager: string): unknown => {
	try {
		return JSON.parse(output);
	} catch {
		throw new Error(`Could not read ${manager} catalog configuration.`);
	}
};

const isObject = (entry: unknown): entry is Record<string, unknown> => (
	entry !== null && typeof entry === 'object' && !Array.isArray(entry)
);
const isStringMap = (entry: unknown): entry is Record<string, string> => (
	isObject(entry) && Object.values(entry).every(item => typeof item === 'string')
);
const isCatalogs = (entry: unknown): entry is Record<string, Record<string, string>> => (
	isObject(entry) && Object.values(entry).every(isStringMap)
);

const parseCatalogConfiguration = (output: string, manager: string): CatalogConfiguration => {
	const value = parseCatalogJson(output, manager);
	if (!isObject(value)
		|| (value.catalog !== undefined && !isStringMap(value.catalog))
		|| (value.catalogs !== undefined && !isCatalogs(value.catalogs))) {
		throw new Error(`Could not read ${manager} catalog configuration.`);
	}
	return value as CatalogConfiguration;
};

export type WorkspacePublicationPlan = PlanFields & (
	| {
		kind: 'standalone';
	}
	| {
		kind: 'workspace';
		rootDirectory: string;
		selection: 'explicit' | 'public-root' | 'default-roots' | 'current-package';
	}
);

export const planStandalonePublication = async ({
	cwd, gitRootPath, packageJson, sourceName, sourceCommitId, publishBranch, workspaceDirectories,
}: {
	cwd: string;
	gitRootPath: string;
	packageJson: PackageJson;
	sourceName: string;
	sourceCommitId: string;
	publishBranch: string | undefined;
	workspaceDirectories?: string[];
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
		kind: 'standalone',
		workspaceDirectories,
		roots: [name],
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
	sourceCommitId: string;
	packageManager: PackageManager;
	publishBranch?: string;
	force: boolean | undefined;
	selection: string[];
}): Promise<Extract<WorkspacePublicationPlan, { kind: 'workspace' }> | { kind: 'standalone';
	workspaceDirectories?: string[]; }> => {
	const workspace = await findWorkspacePackages(cwd, packageManager, gitRootPath);
	if (!workspace) {
		return { kind: 'standalone' };
	}
	const isRoot = path.resolve(cwd) === path.resolve(workspace.rootDirectory);
	const defaultAtRoot = selection.length === 0 && isRoot;
	const publicRoot = defaultAtRoot && Boolean(workspace.rootPackage?.name)
		&& !workspace.rootPackage?.packageJson.private;
	const publishAll = defaultAtRoot && !publicRoot;
	let selectionMode: Extract<WorkspacePublicationPlan, { kind: 'workspace' }>['selection'];
	if (selection.length > 0) {
		selectionMode = 'explicit';
	} else if (publicRoot) {
		selectionMode = 'public-root';
	} else if (publishAll) {
		selectionMode = 'default-roots';
	} else {
		selectionMode = 'current-package';
	}
	const candidates = [...workspace.packages];
	if (workspace.rootPackage && !candidates.some(candidate => (
		candidate.dir === workspace.rootDirectory
	))) {
		candidates.push(workspace.rootPackage);
	}
	const roots = new Set<string>();
	switch (selectionMode) {
		case 'explicit': {
			for (const argument of selection) {
				const pattern = path.resolve(cwd, argument).split(path.sep).join('/');
				const matches = candidates.filter(candidate => candidate.name === argument
					|| micromatch.isMatch(path.resolve(candidate.dir).split(path.sep).join('/'), pattern));
				if (matches.length === 0) {
					throw new Error(`No workspace package matches ${JSON.stringify(argument)}.`);
				}
				for (const match of matches) {
					if (!match.name) {
						throw new Error('Cannot publish the selected workspace root because it has no name.');
					}
					roots.add(match.name);
				}
			}
			break;
		}
		case 'public-root': {
			roots.add(workspace.rootPackage!.name);
			break;
		}
		case 'default-roots': {
			for (const candidate of workspace.packages) {
				if (
					path.resolve(candidate.dir) !== path.resolve(workspace.rootDirectory)
					&& !candidate.packageJson.private
				) {
					roots.add(candidate.name);
				}
			}
			break;
		}
		case 'current-package': {
			const selectedPackage = findWorkspacePackageDirectory(workspace, cwd);
			if (!selectedPackage) {
				return { kind: 'standalone' };
			}
			roots.add(selectedPackage.name);
			break;
		}
		default: {
			const unreachable: never = selectionMode;
			throw new Error(`Unknown selection mode: ${unreachable}`);
		}
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
	const yarnEnvironment = process.env.YARN_ENABLE_TRANSPARENT_WORKSPACES;
	const transparentWorkspaces = yarnEnvironment === undefined
		? yarnSettings?.enableTransparentWorkspaces !== false
		: !['false', '0'].includes(yarnEnvironment.toLowerCase());
	let pnpmLinkWorkspacePackages = false;
	let catalogs: CatalogConfiguration = {};
	const yarnCatalogs = new Map<string, CatalogConfiguration>();
	if (packageManager === 'pnpm') {
		const workspaceConfig = (yaml.load(await fs.readFile(path.join(workspace.rootDirectory, 'pnpm-workspace.yaml'), 'utf8')) ?? {}) as {
			linkWorkspacePackages?: boolean | string;
			'link-workspace-packages'?: boolean | string;
		};
		const npmrc = await fs.readFile(path.join(workspace.rootDirectory, '.npmrc'), 'utf8').catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				return '';
			}
			throw error;
		});
		const configured = process.env.PNPM_CONFIG_LINK_WORKSPACE_PACKAGES
			?? process.env.npm_config_link_workspace_packages
			?? workspaceConfig.linkWorkspacePackages
			?? workspaceConfig['link-workspace-packages']
			?? /^\s*link-workspace-packages\s*=\s*(\S+)\s*$/m.exec(npmrc)?.[1];
		pnpmLinkWorkspacePackages = configured === true || configured === 'true' || configured === 'deep';
	}
	const referencesByPackage = candidates.map(candidate => [candidate, (
		(['dependencies', 'optionalDependencies', 'peerDependencies'] as const).flatMap(field => (
			Object.values(candidate.packageJson[field] ?? {}).filter((value): value is string => (
				typeof value === 'string' && value.startsWith('catalog:')
			))
		))
	)] as const);
	const references = referencesByPackage.flatMap(([, entries]) => entries);
	if (references.length && packageManager === 'pnpm') {
		catalogs = parseCatalogConfiguration(await getStdout(spawn('pnpm', ['config', 'list', '--json'], { cwd: workspace.rootDirectory })), 'pnpm');
	} else if (references.length && packageManager === 'yarn') {
		await Promise.all(referencesByPackage.map(async ([candidate, entries]) => {
			if (!entries.length) { return; }
			const queries = [
				...(entries.includes('catalog:') ? ['catalog'] : []),
				...(entries.some(reference => reference !== 'catalog:') ? ['catalogs'] : []),
			] as const;
			const results = await Promise.all(queries.map(async (query) => {
				const output = await getStdout(spawn('yarn', ['config', 'get', query, '--json'], { cwd: candidate.dir }));
				const value = parseCatalogJson(output, 'Yarn');
				if (query === 'catalog' ? !isStringMap(value) : !isCatalogs(value)) {
					throw new Error('Could not read Yarn catalog configuration.');
				}
				return { [query]: value };
			}));
			yarnCatalogs.set(candidate.dir, Object.assign({}, ...results));
		}));
	} else if (references.length && packageManager === 'bun') {
		const root = workspace.rootPackage?.packageJson as (WorkspacePackage['packageJson'] & {
			catalog?: Record<string, string>;
			catalogs?: Record<string, Record<string, string>>;
			workspaces?: { catalog?: Record<string, string>;
				catalogs?: Record<string, Record<string, string>>; };
		}) | undefined;
		const workspaces = root?.workspaces;
		catalogs = {
			catalog: {
				...root?.catalog,
				...(Array.isArray(workspaces) ? undefined : workspaces?.catalog),
			},
			catalogs: {
				...root?.catalogs,
				...(Array.isArray(workspaces) ? undefined : workspaces?.catalogs),
			},
		};
	}
	const policy = {
		plainRanges: (packageManager !== 'pnpm' || pnpmLinkWorkspacePackages)
			&& (packageManager !== 'yarn' || transparentWorkspaces),
		plainPeers: true,
	};
	const workspaceNames = new Set(candidates.map(candidate => candidate.name));
	const graph = createPublishGraph({
		...workspace,
		packages: candidates,
	}, [...roots], {
		policy,
		resolveSpecification: (from, key, specification) => {
			if (!specification.startsWith('catalog:')) {
				return specification;
			}
			const rawName = specification.slice('catalog:'.length);
			const effectiveCatalogs = packageManager === 'yarn' ? yarnCatalogs.get(from.dir)! : catalogs;
			const name = packageManager === 'bun' ? rawName.trim() : rawName;
			const range = !name || (packageManager !== 'yarn' && name === 'default')
				? effectiveCatalogs.catalog?.[key] ?? (packageManager === 'yarn' ? undefined : effectiveCatalogs.catalogs?.default?.[key])
				: effectiveCatalogs.catalogs?.[name]?.[key];
			if (typeof range !== 'string') {
				if (workspaceNames.has(key)) {
					throw new Error(`Cannot resolve catalog reference ${JSON.stringify(specification)} for dependency ${JSON.stringify(key)} in package ${JSON.stringify(from.name)}.`);
				}
				return specification;
			}
			const match = /^(?:(file|link|workspace):)?(.*)$/.exec(range)!;
			const [, protocol, entry] = match;
			if ((protocol === 'file' || protocol === 'link' || ((protocol === 'workspace' || !protocol) && /^\.{1,2}\//.test(entry!)))) {
				let relative = path.relative(from.dir, path.resolve(workspace.rootDirectory, entry!));
				if (!relative.startsWith('.')) {
					relative = `./${relative}`;
				}
				return `${protocol ?? 'file'}:${relative}`;
			}
			return range;
		},
	});
	if (publicRoot && graph.nodes.length === 1 && graph.peers.length === 0) {
		return {
			kind: 'standalone',
			workspaceDirectories: candidates.map(candidate => candidate.dir),
		};
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
	const plan = {
		kind: 'workspace' as const,
		rootDirectory: workspace.rootDirectory,
		workspaceDirectories: candidates.map(candidate => candidate.dir),
		roots: [...roots],
		selection: selectionMode,
		nodes,
		peers: graph.peers,
	};
	const { edges, reachable } = createInstallGraph(plan);
	for (const root of plan.roots) {
		const members = reachable([root], () => true);
		const names = new Map([[root, root]]);
		for (const edge of edges) {
			if (!members.has(edge.from)) {
				continue;
			}
			const previous = names.get(edge.key);
			if (previous !== undefined && previous !== edge.target) {
				throw new Error(`Install name ${JSON.stringify(edge.key)} refers to both ${JSON.stringify(previous)} and ${JSON.stringify(edge.target)} in the install set for ${JSON.stringify(root)}.`);
			}
			names.set(edge.key, edge.target);
		}
	}
	return plan;
};
