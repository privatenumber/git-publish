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
import { getVersionShaCommit, type VersionSha } from './version-sha.ts';

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

export const formatPublicationMessage = (
	packageName: string | undefined,
	sourceName: string,
	shortCommit: string,
) => `Published ${packageName === undefined ? '' : `${stringify(packageName)} `}from ${stringify(sourceName)} (${shortCommit})`;

const namesSourceCommit = (subject: string, shortCommit: string) => (
	subject.startsWith('Published ') && subject.endsWith(` (${shortCommit})`)
);

/**
 * The short commit named by the parent's version SHA when the new tree equals
 * the parent tree except for that version SHA.
 */
const getVersionShaOnlyChange = async (
	parentTree: string,
	newTree: string,
	manifest: PackageJson,
	versionSha: VersionSha,
	gitOptions: SpawnOptions,
) => {
	// Only the top-level package.json blob may change; an added file or a mode change shows here
	// -z keeps the path exact; trimming text output would match a file named "package.json "
	const { stdout: changed } = await spawnAbortable('git', ['diff-tree', '--raw', '-z', parentTree, newTree], gitOptions);
	const entry = /^:(\d+) (\d+) [\da-f]+ [\da-f]+ M\0package\.json\0$/.exec(changed);
	if (!entry || entry[1] !== entry[2]) {
		return undefined;
	}
	const parentContent = await getStdout(spawnAbortable('git', ['cat-file', 'blob', `${parentTree}:package.json`], gitOptions));
	let parentManifest: unknown;
	try {
		parentManifest = JSON.parse(parentContent);
	} catch {
		// An unparseable parent manifest has no version SHA to compare
		return undefined;
	}
	if (typeof parentManifest !== 'object' || parentManifest === null || Array.isArray(parentManifest)) {
		return undefined;
	}
	const { version, gitHead } = parentManifest as PackageJson;
	const substituted = stringify({
		...manifest,
		version,
		gitHead,
	});
	return substituted === stringify(parentManifest)
		? getVersionShaCommit(versionSha, version, gitHead)
		: undefined;
};

/**
 * Whether the parent publication can stand in for the new tree. With a version
 * SHA, the parent's version SHA must name the source commit its own message names.
 */
const canReuseParent = async (
	parentCommit: string,
	parentTree: string,
	newTree: string,
	manifest: PackageJson,
	versionSha: VersionSha | undefined,
	gitOptions: SpawnOptions,
) => {
	if (!versionSha) {
		return newTree === parentTree;
	}
	const namedCommit = newTree === parentTree
		? getVersionShaCommit(versionSha, versionSha.version, versionSha.gitHead)
		: await getVersionShaOnlyChange(parentTree, newTree, manifest, versionSha, gitOptions);
	if (!namedCommit) {
		return false;
	}
	const subject = await getStdout(spawnAbortable('git', ['log', '-1', '--no-show-signature', '--encoding=UTF-8', '--format=%s', parentCommit], gitOptions));
	return namesSourceCommit(subject, namedCommit);
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
	versionSha,
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
	versionSha?: VersionSha;
	gitOptions: SpawnOptions;
	signal?: AbortSignal;
}): Promise<PackagePreparation> => {
	let manifest: PackageJson | undefined;
	const rewriteManifest = (content: Buffer) => {
		manifest = JSON.parse(content.toString('utf8')) as PackageJson;
		const original = stringify(manifest);
		if (versionSha) {
			// pnpm pack drops build metadata from the packed version
			if (manifest.version !== versionSha.version
				&& !(validationContext.packageManager === 'pnpm' && manifest.version === versionSha.version.split('+')[0])) {
				throw new Error(`Package ${stringify(packageName)} has packed version ${stringify(manifest.version)}, but --version-sha set ${stringify(versionSha.version)}. A lifecycle script or the package manager's pack configuration changed the version.`);
			}
			manifest.version = versionSha.version;
			manifest.gitHead = versionSha.gitHead;
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
	const reusedExistingCommit = parentCommit !== undefined && parentTree !== undefined
		&& await canReuseParent(parentCommit, parentTree, newTree, packedManifest, versionSha, {
			...gitOptions,
			signal,
		});
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
