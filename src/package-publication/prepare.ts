import path from 'node:path';
import fs from 'node:fs/promises';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import semver from 'semver';
import type { PackageJson } from '@npmcli/package-json';
import { extractTarball, type File } from '../utils/extract-tarball.ts';
import { getStdout } from '../utils/get-stdout.ts';
import { gitStatusTracked } from '../utils/git.ts';
import { readJson } from '../utils/read-json.ts';
import { findUnpublishedFilesFieldEntries } from '../utils/unpublished-files-field.ts';
import { toPackageManagerGitUrl } from '../utils/git-url.ts';

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

export const validatePackedWorkspaceDependencies = (packageName: string, manifest: PackageJson) => {
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
		for (const [key, value] of Object.entries(manifest[field] ?? {})) {
			if (value?.startsWith('workspace:')) {
				throw new Error(`Package ${stringify(packageName)} has unresolved ${field} ${stringify(key)}: ${stringify(value)}.`);
			}
		}
	}
};

export const preparePackagePublication = async ({
	packageName,
	sourceManifestPath,
	packedTarball,
	publishWorktree,
	branch,
	fetchUrl,
	commitMessage,
	dependencyEdges,
	dependencyPublications,
	gitOptions,
}: {
	packageName: string;
	sourceManifestPath: string;
	packedTarball: string;
	publishWorktree: string;
	branch: string;
	fetchUrl: string;
	commitMessage: string;
	dependencyEdges: PackagePublicationDependency[];
	dependencyPublications: ReadonlyMap<string, PackagePublication>;
	gitOptions: SpawnOptions;
}): Promise<PackagePreparation> => {
	const worktreeOptions = {
		cwd: publishWorktree,
		env: gitOptions.env,
	};
	const files = await extractTarball(packedTarball, publishWorktree);
	const manifestPath = path.join(publishWorktree, 'package.json');
	const manifest = await readJson(manifestPath) as PackageJson;
	const sourceManifest = await readJson(sourceManifestPath) as PackageJson;
	const original = stringify(manifest);
	for (const edge of dependencyEdges) {
		const field = manifest[edge.field];
		if (field && Object.hasOwn(field, edge.key)) {
			const packed = field[edge.key]!;
			const source = sourceManifest[edge.field]?.[edge.key];
			const alias = /^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(packed);
			if (packed !== source && !semver.validRange(packed)
				&& !(alias && alias[1] === edge.target && semver.validRange(alias[2]!))) {
				throw new Error(`Package ${stringify(packageName)} dependency ${stringify(edge.key)} changed during packing from ${stringify(source)} to ${stringify(packed)}.`);
			}
			field[edge.key] = dependencyPublications.get(edge.target)!.installSpecifier;
		}
	}
	validatePackedWorkspaceDependencies(packageName, manifest);
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
		if (!('preinstall' in scripts || 'install' in scripts || 'postinstall' in scripts)) {
			delete scripts.build;
		}
	}
	delete manifest.workspaces;
	delete manifest.devDependencies;
	if (stringify(manifest) !== original) {
		await fs.writeFile(manifestPath, stringify(manifest, null, 2));
	}
	await spawn('git', ['add', '--all'], worktreeOptions);
	const tracked = await gitStatusTracked(worktreeOptions);
	if (tracked.length > 0) {
		await spawn('git', [
			'-c',
			'user.name=git-publish',
			'-c',
			'user.email=bot@git-publish',
			'commit',
			'--no-verify',
			'-m',
			commitMessage,
			'--author=git-publish <bot@git-publish>',
		], worktreeOptions);
	}
	const commit = await getStdout(spawn('git', ['rev-parse', 'HEAD'], worktreeOptions));
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
		reusedExistingCommit: tracked.length === 0,
		version: manifest.version,
		peerDependencies: manifest.peerDependencies ?? {},
	};
};
