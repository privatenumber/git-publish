import path from 'node:path';
import type { PackageJson } from '@npmcli/package-json';
import type { WorkspacePublicationPlan } from '../workspace-publication/plan.ts';
import type { WorkspacePeer } from '../workspace-publication/graph.ts';
import { satisfiesPackedPeer } from '../workspace-publication/satisfies-range.ts';
import type { PackagePreparation, PackagePublicationDependency } from './prepare.ts';

const { stringify } = JSON;

export type PackedManifestValidationContext = {
	from: string;
	root: string;
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
	for (const edge of dependencyEdges) {
		const packed = manifest[edge.field]?.[edge.key];
		if (packed === undefined) {
			continue;
		}
		const source = edge.specification;
		const target = context.targets.get(edge.target);
		let valid = packed === source;
		if (!valid && target?.version) {
			valid = satisfiesPackedPeer(packed, edge.target, target.version);
		}
		if (!valid && target && /^(?:file|link):/.test(packed)) {
			const [specifier, suffix] = packed.split('::', 2);
			let base = context.from;
			if (suffix) {
				const locator = new URLSearchParams(suffix).get('locator');
				const match = locator && /@workspace:(.*)$/.exec(locator);
				if (!match) {
					throw new Error(`Package ${stringify(packageName)} dependency ${stringify(edge.key)} has an invalid packed locator.`);
				}
				base = path.resolve(context.root, match[1]!);
			}
			valid = path.resolve(base, specifier!.slice(specifier!.indexOf(':') + 1)) === path.resolve(target.dir);
		}
		if (!valid) {
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
