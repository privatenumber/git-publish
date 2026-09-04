import path from 'node:path';
import type { Workspace, WorkspacePackage } from './workspace.ts';

export type DependencyField = 'dependencies' | 'optionalDependencies';

export type PublishGraphEdge = {
	key: string;
	field: DependencyField;
	target: string;
	specification: string;
};

export type PublishGraphNode = {
	key: string;
	package: WorkspacePackage;
	dependencies: PublishGraphEdge[];
};

export type WorkspacePeer = {
	from: string;
	key: string;
	specification: string;
	target?: string;
};

export type PublishGraph = {
	rootDir: string;
	selected: string;
	nodes: PublishGraphNode[];
	peers: WorkspacePeer[];
};

type WorkspaceReference =
	| {
		kind: 'version';
	}
	| {
		kind: 'alias';
		name: string;
	}
	| {
		kind: 'path';
		path: string;
	};

// Only structural malformation is rejected here. Range content is deferred to
// the package manager: any non-empty range resolves by name, and real version
// mismatches surface at pack and install time.
const parseWorkspaceSpecification = (specification: string): WorkspaceReference | undefined => {
	if (!specification.startsWith('workspace:')) {
		return undefined;
	}
	const body = specification.slice('workspace:'.length);
	if (!body) {
		return undefined;
	}
	if (body.startsWith('.')) {
		return {
			kind: 'path',
			path: body,
		};
	}
	const separatorIndex = body.lastIndexOf('@');
	if (separatorIndex > 0) {
		const name = body.slice(0, separatorIndex);
		const range = body.slice(separatorIndex + 1);
		if (!name || !range) {
			return undefined;
		}
		return {
			kind: 'alias',
			name,
		};
	}
	if (body.startsWith('@')) {
		return undefined;
	}
	return {
		kind: 'version',
	};
};

const findPackageByDirectory = (
	packages: WorkspacePackage[],
	directory: string,
) => packages.find(candidate => path.resolve(candidate.dir) === directory);

export const selectWorkspacePackage = (
	workspace: Workspace,
	name: string,
): WorkspacePackage => {
	const matches = workspace.packages.filter(candidate => candidate.name === name);
	if (matches.length > 1) {
		const directories = matches.map(candidate => candidate.dir).sort().map(directory => `- ${directory}`).join('\n');
		throw new Error(`Duplicate workspace package name ${JSON.stringify(name)} found in:\n${directories}`);
	}
	const selected = matches[0];
	if (!selected) {
		const available = workspace.packages.map(candidate => candidate.name).sort().join(', ');
		throw new Error(`Unknown workspace package ${JSON.stringify(name)}. Available packages: ${available}.`);
	}
	return selected;
};

export const resolvePackageDirectory = (
	workspace: Workspace,
	cwd: string,
): WorkspacePackage => {
	const directory = path.resolve(cwd);
	let selected: WorkspacePackage | undefined;
	let selectedLength = -1;
	for (const candidate of workspace.packages) {
		const candidateDirectory = path.resolve(candidate.dir);
		if (directory !== candidateDirectory && !directory.startsWith(`${candidateDirectory}${path.sep}`)) {
			continue;
		}
		if (candidateDirectory.length > selectedLength) {
			selected = candidate;
			selectedLength = candidateDirectory.length;
		}
	}
	if (!selected) {
		throw new Error(`Current directory ${directory} is not inside a workspace package.`);
	}
	return selected;
};

export const createPublishGraph = (
	workspace: Workspace,
	selected: string,
): PublishGraph => {
	const byName = new Map<string, WorkspacePackage[]>();
	for (const candidate of workspace.packages) {
		const group = byName.get(candidate.name);
		if (group) {
			group.push(candidate);
		} else {
			byName.set(candidate.name, [candidate]);
		}
	}
	for (const [name, group] of byName) {
		if (group.length > 1) {
			const directories = group.map(candidate => candidate.dir).sort().map(directory => `- ${directory}`).join('\n');
			throw new Error(`Duplicate workspace package name ${JSON.stringify(name)} found in:\n${directories}`);
		}
	}

	const resolveTarget = (
		from: WorkspacePackage,
		key: string,
		specification: string,
	): string => {
		const reference = parseWorkspaceSpecification(specification);
		if (!reference) {
			throw new Error(`Unsupported workspace specification ${JSON.stringify(specification)} for dependency ${JSON.stringify(key)} in package ${JSON.stringify(from.name)}.`);
		}
		if (reference.kind === 'path') {
			const directory = path.resolve(from.dir, reference.path);
			const target = findPackageByDirectory(workspace.packages, directory);
			if (!target) {
				throw new Error(`Workspace path ${JSON.stringify(reference.path)} required by ${JSON.stringify(from.name)} does not resolve to a discovered package.`);
			}
			return target.name;
		}
		const name = reference.kind === 'alias' ? reference.name : key;
		if (!byName.has(name)) {
			throw new Error(`Unknown workspace package ${JSON.stringify(name)} required by ${JSON.stringify(from.name)}.`);
		}
		return name;
	};

	const tryResolveTarget = (
		from: WorkspacePackage,
		key: string,
		specification: string,
	): string | undefined => {
		try {
			return resolveTarget(from, key, specification);
		} catch {
			// Peer diagnostics never fail graph construction. Unresolvable
			// references are reported with an undefined target.
			return undefined;
		}
	};

	const nodes = new Map<string, PublishGraphNode>();
	const peers: WorkspacePeer[] = [];
	const visited = new Set<string>();
	const visiting: string[] = [];

	const visit = (current: WorkspacePackage): void => {
		if (visited.has(current.name)) {
			return;
		}
		const cycleStart = visiting.indexOf(current.name);
		if (cycleStart !== -1) {
			throw new Error(`Dependency cycle detected: ${[...visiting.slice(cycleStart), current.name].join(' -> ')}.`);
		}
		visiting.push(current.name);
		const dependencies: PublishGraphEdge[] = [];
		for (const field of ['dependencies', 'optionalDependencies'] as const) {
			const entries = current.packageJson[field] ?? {};
			for (const [key, specification] of Object.entries(entries)) {
				if (typeof specification !== 'string' || !specification.startsWith('workspace:')) {
					continue;
				}
				const target = resolveTarget(current, key, specification);
				dependencies.push({
					key,
					field,
					target,
					specification,
				});
				visit(byName.get(target)![0]);
			}
		}
		const peerEntries = current.packageJson.peerDependencies ?? {};
		for (const [key, specification] of Object.entries(peerEntries)) {
			if (typeof specification !== 'string') {
				continue;
			}
			const isWorkspaceProtocol = specification.startsWith('workspace:');
			let target: string | undefined;
			if (isWorkspaceProtocol) {
				target = tryResolveTarget(current, key, specification);
			} else if (byName.has(key)) {
				target = key;
			}
			if (target === undefined && !isWorkspaceProtocol) {
				continue;
			}
			peers.push({
				from: current.name,
				key,
				specification,
				target,
			});
		}
		visiting.pop();
		visited.add(current.name);
		nodes.set(current.name, {
			key: current.name,
			package: current,
			dependencies,
		});
	};

	visit(selectWorkspacePackage(workspace, selected));

	return {
		rootDir: workspace.rootDir,
		selected,
		nodes: [...nodes.values()],
		peers,
	};
};
