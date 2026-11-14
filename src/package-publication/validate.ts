import path from 'node:path';
import semver from 'semver';
import type { PackageJson } from '@npmcli/package-json';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import type { WorkspacePublicationPlan } from '../workspace-publication/plan.ts';
import { parseWorkspaceSpecification, type WorkspacePeer } from '../workspace-publication/graph.ts';
import { satisfiesPackedPeer } from '../workspace-publication/satisfies-range.ts';
import type { PackagePreparation, PackagePublicationDependency } from './prepare.ts';

const { stringify } = JSON;

export type PackedManifestValidationContext = {
	from: string;
	root: string;
	packageManager: PackageManager;
	targets: ReadonlyMap<string, {
		dir: string;
		version?: string;
		sourceVersion?: string;
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
	const resolvePath = (packed: string) => {
		let specifier = packed;
		let base = context.from;
		const separator = packed.indexOf('::');
		if (context.packageManager === 'yarn' && separator !== -1) {
			const suffix = packed.slice(separator + 2);
			const locator = new URLSearchParams(suffix).get('locator');
			const match = locator && /^.+@workspace:(.+)$/.exec(locator);
			if (match) {
				specifier = packed.slice(0, separator);
				base = path.resolve(context.root, match[1]!);
			}
		}
		const localPath = specifier.replace(/^(?:file|link|portal|workspace):/, '');
		return {
			localPath,
			base,
			resolved: path.resolve(base, localPath),
		};
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
			? (['^', '~'].includes(workspace.range) ? `${workspace.range}${target?.sourceVersion ?? '*'}` : workspace.range)
			: packed;
		let valid = packed === source && (!semver.validRange(range)
			|| Boolean(target?.version && satisfiesPackedPeer(range, edge.target, target.version)));
		if (!valid && target?.version) {
			valid = satisfiesPackedPeer(packed, edge.target, target.version);
		}
		if (!valid && target && /^(?:file|link):/.test(packed)) {
			valid = resolvePath(packed).resolved === path.resolve(target.dir);
		}
		if (!valid) {
			if (packed === source && semver.validRange(range)) {
				throw new Error(`Package ${stringify(packageName)} dependency ${stringify(edge.key)} requires ${stringify(packed)}, but its packed version is ${stringify(target?.version)}.`);
			}
			throw new Error(`Package ${stringify(packageName)} dependency ${stringify(edge.key)} changed during packing from ${stringify(source)} to ${stringify(packed)}.`);
		}
	}
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
		for (const [key, value] of Object.entries(manifest[field] ?? {})) {
			if (typeof value !== 'string' || dependencyEdges.some(edge => edge.field === field && edge.key === key)
				|| (field === 'dependencies' && Object.hasOwn(manifest.optionalDependencies ?? {}, key))
				|| (field === 'peerDependencies' && peers.some(peer => peer.key === key && peer.target))) {
				continue;
			}
			const workspace = parseWorkspaceSpecification(value);
			if (!/^(?:file|link|portal):/.test(value) && workspace?.kind !== 'path'
				&& !(value.startsWith('workspace:') && /^[/~]|^[a-z]:|^\\/i.test(value.slice(10)))
				&& !/^[./~]/.test(value)) {
				continue;
			}
			const { localPath, base } = resolvePath(value);
			const normalized = path.posix.normalize(localPath.replaceAll('\\', '/'));
			const relative = path.relative(context.from, path.resolve(base, normalized));
			if (/^[/~]|^[a-z]:/i.test(localPath) || path.win32.isAbsolute(localPath)
				|| relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				throw new Error(`Package ${stringify(packageName)} has ${field} ${stringify(key)}: ${stringify(value)}, a local path that consumers installing from Git can't resolve. Use a path inside the package, such as file:./vendor/core.`);
			}
		}
	}
	const rewritten = structuredClone(manifest);
	for (const edge of dependencyEdges) {
		if (rewritten[edge.field] && Object.hasOwn(rewritten[edge.field]!, edge.key)) {
			rewritten[edge.field]![edge.key] = '';
		}
	}
	for (const peer of peers) {
		const range = manifest.peerDependencies?.[peer.key];
		if (peer.target && range !== undefined && typeof range !== 'string') {
			throw new Error(`Package ${stringify(peer.from)} has invalid packed peer ${stringify(peer.key)}: ${stringify(range)}.`);
		}
		if (peer.target && range !== undefined && /^(?:file|link):/.test(range)) {
			throw new Error(`Package ${stringify(peer.from)} declares peer ${stringify(peer.key)} as ${stringify(range)}, which consumers cannot resolve. Use a workspace: specifier or a version range.`);
		}
	}
	validatePackedWorkspaceDependencies(packageName, rewritten);
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
