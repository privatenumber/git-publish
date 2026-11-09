import semver from 'semver';
import type { PackageJson } from '@npmcli/package-json';
import type { WorkspacePublicationPlan } from '../workspace-publication/plan.ts';
import type { WorkspacePeer } from '../workspace-publication/graph.ts';
import { parseAliasedRange, satisfiesPackedPeer } from '../workspace-publication/satisfies-range.ts';
import type { PackagePreparation, PackagePublicationDependency } from './prepare.ts';

const { stringify } = JSON;

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
	sourceManifest: PackageJson,
	dependencyEdges: PackagePublicationDependency[],
	peers: WorkspacePeer[],
) => {
	if (manifest.name !== packageName) {
		throw new Error(`Package ${stringify(packageName)} has packed name ${stringify(manifest.name)}.`);
	}
	const planned = new Set([
		...dependencyEdges.map(edge => `${edge.field}\0${edge.key}`),
		...peers.map(peer => `peerDependencies\0${peer.key}`),
	]);
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
		for (const [key, packed] of Object.entries(manifest[field] ?? {})) {
			if (!Object.hasOwn(sourceManifest[field] ?? {}, key)) {
				throw new Error(`Package ${stringify(packageName)} adds ${field} ${stringify(key)} during packing. Pack hooks may remove dependencies but not add them.`);
			}
			const source = sourceManifest[field]?.[key];
			if (packed !== source && !planned.has(`${field}\0${key}`)
				&& !source?.startsWith('workspace:') && !source?.startsWith('catalog:')) {
				throw new Error(`Package ${stringify(packageName)} changes ${field} ${stringify(key)} during packing from ${stringify(source)} to ${stringify(packed)}.`);
			}
		}
	}
	for (const key of Object.keys(sourceManifest.optionalDependencies ?? {})) {
		if (!Object.hasOwn(manifest.optionalDependencies ?? {}, key)
			&& Object.hasOwn(manifest.dependencies ?? {}, key)) {
			throw new Error(`Package ${stringify(packageName)} removes optionalDependencies ${stringify(key)} during packing while it remains in dependencies.`);
		}
	}
	for (const edge of dependencyEdges) {
		const packed = manifest[edge.field]?.[edge.key];
		if (packed === undefined) {
			continue;
		}
		const source = sourceManifest[edge.field]?.[edge.key];
		const alias = parseAliasedRange(packed);
		if (packed !== source && !semver.validRange(packed)
			&& !(alias && alias.target === edge.target && semver.validRange(alias.range))) {
			throw new Error(`Package ${stringify(packageName)} dependency ${stringify(edge.key)} changed during packing from ${stringify(source)} to ${stringify(packed)}.`);
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
