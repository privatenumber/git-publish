import path from 'node:path';
import type { Workspace, WorkspacePackage } from './discover.ts';
import { satisfiesWorkspaceRange } from './satisfies-range.ts';

export type DependencyField = 'dependencies' | 'optionalDependencies';

export type PublishGraphEdge = {
	key: string;
	field: DependencyField;
	target: string;
};

export type PublishGraphNode = {
	key: string;
	package: WorkspacePackage;
	dependencies: PublishGraphEdge[];
	role: 'root' | 'dependency' | 'peer';
};

export type WorkspacePeer = {
	from: string;
	key: string;
	specification: string;
	optional: boolean;
	target?: string;
};

export type PublishGraph = {
	nodes: PublishGraphNode[];
	peers: WorkspacePeer[];
};

type WorkspaceReference =
	| {
		kind: 'version';
		range: string;
	}
	| {
		kind: 'alias';
		name: string;
		range: string;
	}
	| {
		kind: 'path';
		path: string;
	};

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
			range,
		};
	}
	if (body.startsWith('@')) {
		return undefined;
	}
	return {
		kind: 'version',
		range: body,
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

export const findWorkspacePackageDirectory = (
	workspace: Workspace,
	cwd: string,
): WorkspacePackage | undefined => {
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
	return selected;
};

export const createPublishGraph = (
	workspace: Workspace,
	roots: string[],
	{ policy }: { policy: { plainRanges: boolean;
		plainPeers: boolean; }; },
): PublishGraph => {
	const rootNames = new Set(roots);
	const byName = new Map<string, WorkspacePackage[]>();
	const byDirectory = new Map(workspace.packages.map(candidate => (
		[path.resolve(candidate.dir), candidate.name]
	)));
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
	const resolvePlainTarget = (
		from: WorkspacePackage,
		key: string,
		specification: string,
		peer = false,
	): string | undefined => {
		if (specification.startsWith('file:') || specification.startsWith('link:')) {
			return byDirectory.get(path.resolve(from.dir, specification.slice(specification.indexOf(':') + 1)));
		}
		const candidate = byName.get(key)?.[0];
		const version = candidate?.packageJson.version;
		if (
			(peer ? policy.plainPeers : policy.plainRanges)
			&& version && satisfiesWorkspaceRange(version, specification)
		) {
			return key;
		}
		return undefined;
	};
	const validateWorkspaceRange = (
		from: WorkspacePackage,
		key: string,
		specification: string,
		target: string,
	) => {
		const reference = parseWorkspaceSpecification(specification);
		if (!reference || reference.kind === 'path' || ['*', '^', '~'].includes(reference.range)) {
			return;
		}
		const { version } = byName.get(target)![0]!.packageJson;
		if (!version || !satisfiesWorkspaceRange(version, reference.range)) {
			throw new Error(`Package ${JSON.stringify(from.name)} requires ${JSON.stringify(key)} in workspace range ${JSON.stringify(reference.range)}, but ${JSON.stringify(target)} has version ${JSON.stringify(version)}.`);
		}
	};

	const resolveEdge = (
		from: WorkspacePackage, key: string, specification: string, peer: boolean,
	) => {
		if (!specification.startsWith('workspace:')) {
			return resolvePlainTarget(from, key, specification, peer);
		}
		const target = peer
			? tryResolveTarget(from, key, specification)
			: resolveTarget(from, key, specification);
		if (target) {
			validateWorkspaceRange(from, key, specification, target);
		}
		return target;
	};

	const nodes = new Map<string, PublishGraphNode>();
	const peers: WorkspacePeer[] = [];
	const pendingPeers: WorkspacePeer[] = [];
	const visited = new Set<string>();
	const visiting: string[] = [];

	const visit = (current: WorkspacePackage, role: 'dependency' | 'peer'): void => {
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
				if (field === 'dependencies' && Object.hasOwn(current.packageJson.optionalDependencies ?? {}, key)) {
					continue;
				}
				if (typeof specification !== 'string') {
					continue;
				}
				const target = resolveEdge(current, key, specification, false);
				if (!target) {
					continue;
				}
				dependencies.push({
					key,
					field,
					target,
				});
				visit(byName.get(target)![0]!, role);
			}
		}
		const peerEntries = current.packageJson.peerDependencies ?? {};
		for (const [key, specification] of Object.entries(peerEntries)) {
			if (typeof specification !== 'string') {
				continue;
			}
			const isWorkspaceProtocol = specification.startsWith('workspace:');
			const optional = current.packageJson.peerDependenciesMeta?.[key]?.optional === true;
			const target = resolveEdge(current, key, specification, true);
			if (target === undefined && !isWorkspaceProtocol) {
				if (byName.has(key)) {
					pendingPeers.push({
						from: current.name,
						key,
						specification,
						optional,
						target: key,
					});
				}
				continue;
			}
			peers.push({
				from: current.name,
				key,
				specification,
				optional,
				target,
			});
		}
		visiting.pop();
		visited.add(current.name);
		nodes.set(current.name, {
			key: current.name,
			package: current,
			dependencies,
			role: rootNames.has(current.name) ? 'root' : role,
		});
	};

	for (const root of roots) {
		visit(selectWorkspacePackage(workspace, root), 'dependency');
	}
	for (let index = 0; index < peers.length; index += 1) {
		const { target } = peers[index]!;
		if (target) {
			visit(byName.get(target)![0]!, 'peer');
		}
	}
	for (const peer of pendingPeers) {
		if (nodes.has(peer.target!)) {
			peers.push(peer);
		}
	}

	return {
		nodes: [...nodes.values()],
		peers,
	};
};
