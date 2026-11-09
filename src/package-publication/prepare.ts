import spawn, { SubprocessError, type Options as SpawnOptions } from 'nano-spawn';
import type { PackageJson } from '@npmcli/package-json';
import { getStdout } from '../utils/get-stdout.ts';
import { readJson } from '../utils/read-json.ts';
import { findUnpublishedFilesFieldEntries } from '../utils/unpublished-files-field.ts';
import { toPackageManagerGitUrl } from '../utils/git-url.ts';
import type { WorkspacePeer } from '../workspace-publication/graph.ts';
import { importTarball, type File } from './import-tarball.ts';
import { validatePackedManifest } from './validate.ts';

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
};

export type PackagePublicationDependency = {
	key: string;
	field: 'dependencies' | 'optionalDependencies';
	target: string;
};

export const toInstallSpecifier = (fetchUrl: string, commit: string) => `${toPackageManagerGitUrl(fetchUrl)}#${commit}`;

export const preparePackagePublication = async ({
	packageName,
	sourceManifestPath,
	packedTarball,
	importRef,
	parent,
	branch,
	fetchUrl,
	commitMessage,
	dependencyEdges,
	dependencyPublications,
	peers = [],
	gitOptions,
}: {
	packageName: string;
	sourceManifestPath: string;
	packedTarball: string;
	importRef: string;
	parent: string | undefined;
	branch: string;
	fetchUrl: string;
	commitMessage: string;
	dependencyEdges: PackagePublicationDependency[];
	dependencyPublications: ReadonlyMap<string, PackagePublication>;
	peers?: WorkspacePeer[];
	gitOptions: SpawnOptions;
}): Promise<PackagePreparation> => {
	const sourceManifest = await readJson(sourceManifestPath) as PackageJson;
	let manifest: PackageJson | undefined;
	const rewriteManifest = (content: Buffer) => {
		manifest = JSON.parse(content.toString('utf8')) as PackageJson;
		const original = stringify(manifest);
		validatePackedManifest(packageName, manifest, sourceManifest, dependencyEdges, peers);
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
	const files = await importTarball({
		tarball: packedTarball,
		ref: importRef,
		parent,
		message: commitMessage,
		gitOptions,
		rewriteManifest,
	});
	if (!manifest) {
		throw new Error('Packed package is missing package.json');
	}
	const importedCommit = await getStdout(spawn('git', ['rev-parse', importRef], gitOptions));
	const [newTree, parentTree] = await Promise.all([
		getStdout(spawn('git', ['rev-parse', `${importedCommit}^{tree}`], gitOptions)),
		parent ? getStdout(spawn('git', ['rev-parse', `${parent}^{tree}`], gitOptions)) : undefined,
	]);
	const reusedExistingCommit = parentTree !== undefined && newTree === parentTree;
	let commit: string;
	if (reusedExistingCommit) {
		commit = await getStdout(spawn('git', ['rev-parse', parent!], gitOptions));
	} else {
		const signing = await getStdout(spawn('git', ['config', '--type=bool', '--get', 'commit.gpgSign'], gitOptions)).catch((error: unknown) => {
			if (error instanceof SubprocessError && error.exitCode === 1) {
				return 'false';
			}
			throw error;
		});
		commit = await getStdout(spawn('git', [
			'commit-tree',
			newTree,
			...(parent ? ['-p', parent] : []),
			...(signing === 'true' ? ['-S'] : []),
			'-m',
			commitMessage,
		], {
			...gitOptions,
			env: {
				...gitOptions.env,
				GIT_AUTHOR_NAME: 'git-publish',
				GIT_AUTHOR_EMAIL: 'bot@git-publish',
				GIT_COMMITTER_NAME: 'git-publish',
				GIT_COMMITTER_EMAIL: 'bot@git-publish',
			},
		}));
	}
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
			manifest.files,
			files.map(file => file.file),
		),
		reusedExistingCommit,
		version: manifest.version,
		peerDependencies: manifest.peerDependencies ?? {},
	};
};
