import path from 'node:path';
import fs from 'node:fs/promises';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import type { PackageJson } from '@npmcli/package-json';
import { extractTarball, type File } from '../utils/extract-tarball.ts';
import { getStdout } from '../utils/get-stdout.ts';
import { gitStatusTracked } from '../utils/git.ts';
import { readJson } from '../utils/read-json.ts';
import { findUnpublishedFilesFieldEntries } from '../utils/unpublished-files-field.ts';

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

const toPackageManagerGitUrl = (url: string) => {
	const parsed = URL.parse(url.replace(/^git\+/, ''));
	if (parsed?.protocol === 'ssh:') {
		parsed.password = '';
		return `git+${parsed.href}`;
	}
	if (parsed && ['http:', 'https:', 'git:'].includes(parsed.protocol)) {
		parsed.username = '';
		parsed.password = '';
		return `git+${parsed.href}`;
	}
	if (url.startsWith('git+')) {
		return url;
	}
	if (/^(?:file|git|https?|ssh):\/\//.test(url)) {
		return `git+${url}`;
	}
	const scpUrl = /^(?<user>[^@/:]+@)?(?<host>[^/:]+):(?<path>.+)$/.exec(url)?.groups;
	if (scpUrl) {
		const hosted = ['github.com', 'gitlab.com', 'bitbucket.org'].includes(scpUrl.host!);
		const pathname = scpUrl.path!.startsWith('/') ? scpUrl.path : `${hosted ? '/' : '/~/'}${scpUrl.path}`;
		return `git+ssh://${scpUrl.user ?? ''}${scpUrl.host}${pathname}`;
	}
	return `git+file://${path.resolve(url)}`;
};

export const toInstallSpecifier = (fetchUrl: string, commit: string) => `${toPackageManagerGitUrl(fetchUrl)}#${commit}`;

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
	const original = stringify(manifest);
	for (const edge of dependencyEdges) {
		const dependency = dependencyPublications.get(edge.target)!;
		const field = manifest[edge.field] ?? {};
		field[edge.key] = dependency.installSpecifier;
		manifest[edge.field] = field;
	}
	const sourceManifest = await readJson(sourceManifestPath) as PackageJson;
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const) {
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
