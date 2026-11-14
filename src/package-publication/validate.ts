import path from 'node:path';
import semver from 'semver';
import type { PackageJson } from '@npmcli/package-json';
import type { WorkspacePublicationPlan } from '../workspace-publication/plan.ts';
import { parseWorkspaceSpecification, type WorkspacePeer } from '../workspace-publication/graph.ts';
import { satisfiesPackedPeer } from '../workspace-publication/satisfies-range.ts';
import type { PackagePreparation, PackagePublicationDependency } from './prepare.ts';

const { stringify } = JSON;

export type PackedManifestValidationContext = {
	from: string;
	root: string;
	workspaceDirectories: readonly string[];
	targets: ReadonlyMap<string, {
		dir: string;
		version?: string;
	}>;
};

export const validatePackedWorkspaceDependencies = (packageName: string, manifest: PackageJson) => {
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
		for (const [key, value] of Object.entries(manifest[field] ?? {})) {
			if (value?.startsWith('workspace:')) {
				throw new Error(`Package ${stringify(packageName)} has unresolved ${field} ${stringify(key)}: ${stringify(value)}.`);
			}
		}
	}
};

export const validatePackedManifest = (
	packageName: string,
	manifest: PackageJson,
	dependencyEdges: PackagePublicationDependency[],
	peers: WorkspacePeer[],
	context: PackedManifestValidationContext,
) => {
	if (manifest.name !== packageName) {
		throw new Error(`Package ${stringify(packageName)} has packed name ${stringify(manifest.name)}.`);
	}
	const resolvePath = (key: string, packed: string) => {
		const [specifier, suffix] = packed.split('::', 2);
		let base = context.from;
		if (suffix) {
			const locator = new URLSearchParams(suffix).get('locator');
			const match = locator && /@workspace:(.*)$/.exec(locator);
			if (!match) {
				throw new Error(`Package ${stringify(packageName)} dependency ${stringify(key)} has an invalid packed locator.`);
			}
			base = path.resolve(context.root, match[1]!);
		}
		return path.resolve(base, specifier!.slice(specifier!.indexOf(':') + 1));
	};
	for (const edge of dependencyEdges) {
		const packed = manifest[edge.field]?.[edge.key];
		if (packed === undefined) {
			continue;
		}
		const source = edge.specification;
		const target = context.targets.get(edge.target);
		const workspace = parseWorkspaceSpecification(packed);
		const range = workspace && workspace.kind !== 'path'
			? (['*', '^', '~'].includes(workspace.range) ? '*' : workspace.range)
			: packed;
		let valid = packed === source && (!semver.validRange(range)
			|| Boolean(target?.version && satisfiesPackedPeer(range, edge.target, target.version)));
		if (!valid && target?.version) {
			valid = satisfiesPackedPeer(packed, edge.target, target.version);
		}
		if (!valid && target && /^(?:file|link):/.test(packed)) {
			valid = resolvePath(edge.key, packed) === path.resolve(target.dir);
		}
		if (!valid) {
			throw new Error(`Package ${stringify(packageName)} dependency ${stringify(edge.key)} changed during packing from ${stringify(source)} to ${stringify(packed)}.`);
		}
	}
	const directories = new Set(context.workspaceDirectories.map(directory => (
		path.resolve(directory)
	)));
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
		for (const [key, value] of Object.entries(manifest[field] ?? {})) {
			if (typeof value !== 'string' || dependencyEdges.some(edge => edge.field === field && edge.key === key)
				|| (field === 'peerDependencies' && peers.some(peer => peer.key === key && peer.target))) {
				continue;
			}
			const workspace = parseWorkspaceSpecification(value);
			if ((/^(?:file|link):/.test(value) || workspace?.kind === 'path')
				&& directories.has(resolvePath(key, value))) {
				throw new Error(`Package ${stringify(packageName)} has unplanned ${field} ${stringify(key)}: ${stringify(value)} pointing to a workspace package.`);
			}
		}
	}
	const rewritten = structuredClone(manifest);
	for (const edge of dependencyEdges) {
		if (rewritten[edge.field] && Object.hasOwn(rewritten[edge.field]!, edge.key)) {
			rewritten[edge.field]![edge.key] = '';
		}
	}
	validatePackedWorkspaceDependencies(packageName, rewritten);
	for (const peer of peers) {
		const range = manifest.peerDependencies?.[peer.key];
		if (peer.target && range !== undefined && /^(?:file|link):/.test(range)) {
			throw new Error(`Package ${stringify(peer.from)} declares peer ${stringify(peer.key)} as ${stringify(range)}, which consumers cannot resolve. Use a workspace: specifier or a version range.`);
		}
	}
};

export const validatePeerRanges = (
	plan: WorkspacePublicationPlan,
	preparations: ReadonlyMap<string, PackagePreparation>,
) => {
	for (const peer of plan.peers) {
		if (!peer.target) {
			continue;
		}
		const range = preparations.get(peer.from)!.peerDependencies[peer.key];
		if (range === undefined) {
			continue;
		}
		const { version } = preparations.get(peer.target)!;
		if (!version || !satisfiesPackedPeer(range, peer.target, version)) {
			throw new Error(`Package ${stringify(peer.from)} requires peer ${stringify(peer.target)} in range ${stringify(range)}, but its packed version is ${stringify(version)}.`);
		}
	}
};
