import spawn, { SubprocessError, type Options as SpawnOptions } from 'nano-spawn';
import type { PackageJson } from '@npmcli/package-json';
import { getStdout } from '../utils/get-stdout.ts';
import { spawnAbortable } from '../utils/spawn-abortable.ts';
import { findUnpublishedFilesFieldEntries } from '../utils/unpublished-files-field.ts';
import { toPackageManagerGitUrl } from '../utils/git-url.ts';
import type { WorkspacePeer, PublishGraphEdge } from '../workspace-publication/graph.ts';
import type { WorkspacePackage } from '../workspace-publication/discover.ts';
import { importTarball, type File } from './import-tarball.ts';
import { validatePackedManifest, type PackedManifestValidationContext } from './validate.ts';
import { isCommitStampOf, type CommitStamp } from './commit-stamp.ts';

const { stringify } = JSON;

export type PackagePublication = {
	packageName: string;
	branch: string;
	commit: string;
	installSpecifier: string;
};

export type PackagePreparation = {
	publication: PackagePublication;
	files: File[];
	unpublishedFilesFieldEntries: string[];
	reusedExistingCommit: boolean;
	version: string | undefined;
	peerDependencies: Partial<Record<string, string>>;
	dependencies: PublishGraphEdge[];
	peers: WorkspacePeer[];
};

export type PackagePublicationDependency = PublishGraphEdge;

/**
 * Whether the new tree equals the parent tree except for the parent's commit stamp.
 * The parent's stamp names the source commit in the parent's own commit message,
 * so reusing the parent keeps an unchanged package's install specifier.
 */
const isStampOnlyChange = async (
	parentTree: string,
	newTree: string,
	manifest: PackageJson,
	stamp: CommitStamp,
	gitOptions: SpawnOptions,
) => {
	const changed = await getStdout(spawn('git', ['diff-tree', '--name-only', parentTree, newTree], gitOptions));
	if (changed !== 'package.json') {
		return false;
	}
	const parentContent = await getStdout(spawn('git', ['cat-file', 'blob', `${parentTree}:package.json`], gitOptions)).catch((error: unknown) => {
		// Git exits with 128 when the parent has no package.json
		if (error instanceof SubprocessError && error.exitCode === 128) {
			return undefined;
		}
		throw error;
	});
	if (parentContent === undefined) {
		return false;
	}
	let parentManifest: PackageJson;
	try {
		parentManifest = JSON.parse(parentContent) as PackageJson;
	} catch {
		// An unparseable parent manifest has no stamp to compare
		return false;
	}
	return isCommitStampOf(stamp, parentManifest.version, parentManifest.gitHead)
		&& stringify({
			...manifest,
			version: parentManifest.version,
			gitHead: parentManifest.gitHead,
		}) === stringify(parentManifest);
};

export const toInstallSpecifier = (fetchUrl: string, commit: string) => `${toPackageManagerGitUrl(fetchUrl)}#${commit}`;

export const preparePackagePublication = async ({
	packageName,
	sourceManifest,
	packedTarball,
	importRef,
	parent,
	branch,
	fetchUrl,
	commitMessage,
	dependencyEdges,
	dependencyPublications,
	validationContext,
	peers = [],
	commitStamp,
	gitOptions,
	signal,
}: {
	packageName: string;
	sourceManifest: WorkspacePackage['packageJson'];
	packedTarball: string;
	importRef: string;
	parent: string | undefined;
	branch: string;
	fetchUrl: string;
	commitMessage: string;
	dependencyEdges: PackagePublicationDependency[];
	dependencyPublications: ReadonlyMap<string, PackagePublication>;
	validationContext: PackedManifestValidationContext;
	peers?: WorkspacePeer[];
	commitStamp?: CommitStamp;
	gitOptions: SpawnOptions;
	signal?: AbortSignal;
}): Promise<PackagePreparation> => {
	let manifest: PackageJson | undefined;
	const rewriteManifest = (content: Buffer) => {
		manifest = JSON.parse(content.toString('utf8')) as PackageJson;
		const original = stringify(manifest);
		if (commitStamp) {
			// pnpm pack drops build metadata from the packed version
			if (manifest.version !== commitStamp.version
				&& manifest.version !== commitStamp.version.split('+')[0]) {
				throw new Error(`Package ${stringify(packageName)} has packed version ${stringify(manifest.version)}, but --stamp-commit set ${stringify(commitStamp.version)}. A pack hook changed the version.`);
			}
			manifest.version = commitStamp.version;
			manifest.gitHead = commitStamp.gitHead;
		}
		for (const { key, field } of [
			...dependencyEdges,
			...peers.map(peer => ({
				key: peer.key,
				field: 'peerDependencies' as const,
			})),
		]) {
			if (Object.hasOwn(manifest[field] ?? {}, key)) {
				continue;
			}
			if (field === 'optionalDependencies' && Object.hasOwn(manifest.dependencies ?? {}, key)) {
				throw new Error(`Package ${stringify(packageName)} removes optionalDependencies ${stringify(key)} during packing while it remains in dependencies.`);
			}
			for (const other of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
				if (Object.hasOwn(manifest[other] ?? {}, key)
					&& !Object.hasOwn(sourceManifest[other] ?? {}, key)) {
					throw new Error(`Package ${stringify(packageName)} moves ${stringify(key)} from ${field} to ${other} during packing. Pack hooks may remove internal dependencies but not move them.`);
				}
			}
		}
		validatePackedManifest(packageName, manifest, dependencyEdges, peers, validationContext);
		for (const edge of dependencyEdges) {
			const field = manifest[edge.field];
			if (field && Object.hasOwn(field, edge.key)) {
				field[edge.key] = dependencyPublications.get(edge.target)!.installSpecifier;
			}
		}
		for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
			const packed = manifest[field];
			if (packed) {
				const ordered: Record<string, string> = {};
				for (const key of [...Object.keys(sourceManifest[field] ?? {}), ...Object.keys(packed)]) {
					if (Object.hasOwn(packed, key)) {
						ordered[key] = packed[key]!;
					}
				}
				manifest[field] = ordered;
			}
		}
		const { scripts } = manifest;
		if (scripts) {
			delete scripts.prepare;
			delete scripts.prepack;
			delete scripts.postpack;
			if (!('preinstall' in scripts || 'install' in scripts || 'postinstall' in scripts)) {
				delete scripts.build;
			}
		}
		delete manifest.workspaces;
		delete manifest.devDependencies;
		return stringify(manifest) === original ? content : Buffer.from(stringify(manifest, null, 2));
	};
	const { files, tree: newTree } = await importTarball({
		tarball: packedTarball,
		ref: importRef,
		gitOptions,
		rewriteManifest,
		signal,
	});
	signal?.throwIfAborted();
	if (!manifest) {
		throw new Error('Packed package is missing package.json');
	}
	const packedManifest = manifest;
	const { peerDependencies, peerDependenciesMeta } = packedManifest;
	const parentRevisions = parent
		? await getStdout(spawn('git', ['rev-parse', parent, `${parent}^{tree}`], gitOptions))
		: '';
	const [parentCommit, parentTree] = parentRevisions ? parentRevisions.split('\n') : [];
	const reusedExistingCommit = parentTree !== undefined && (
		newTree === parentTree
		|| (commitStamp !== undefined && await isStampOnlyChange(
			parentTree,
			newTree,
			packedManifest,
			commitStamp,
			gitOptions,
		))
	);
	let commit: string;
	if (parentCommit && reusedExistingCommit) {
		commit = parentCommit;
	} else {
		const signing = await getStdout(spawn('git', ['config', '--type=bool', '--get', 'commit.gpgSign'], gitOptions)).catch((error: unknown) => {
			if (error instanceof SubprocessError && error.exitCode === 1) {
				return 'false';
			}
			throw error;
		});
		commit = await getStdout(spawnAbortable('git', [
			'-c',
			'user.name=git-publish',
			'-c',
			'user.email=bot@git-publish',
			'commit-tree',
			newTree,
			...(parent ? ['-p', parent] : []),
			...(signing === 'true' ? ['-S'] : []),
			'-m',
			commitMessage,
		], {
			...gitOptions,
			signal,
			env: {
				...gitOptions.env,
				GIT_AUTHOR_NAME: 'git-publish',
				GIT_AUTHOR_EMAIL: 'bot@git-publish',
			},
		}));
	}
	signal?.throwIfAborted();
	await spawn('git', ['update-ref', importRef, commit], gitOptions);
	return {
		publication: {
			packageName,
			branch,
			commit,
			installSpecifier: toInstallSpecifier(fetchUrl, commit),
		},
		files,
		unpublishedFilesFieldEntries: findUnpublishedFilesFieldEntries(
			packedManifest.files,
			files.map(file => file.file),
		),
		reusedExistingCommit,
		version: packedManifest.version,
		peerDependencies: peerDependencies ?? {},
		dependencies: dependencyEdges.filter(edge => (
			Object.hasOwn(packedManifest[edge.field] ?? {}, edge.key)
		)),
		peers: peers.filter(peer => (
			Object.hasOwn(peerDependencies ?? {}, peer.key)
		)).map(peer => ({
			...peer,
			optional: peerDependenciesMeta?.[peer.key]?.optional === true,
		})),
	};
};
