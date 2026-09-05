import path from 'node:path';
import fs from 'node:fs/promises';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import type { PackageJson } from '@npmcli/package-json';
import { extractTarball, type File } from '../utils/extract-tarball.ts';
import { getStdout } from '../utils/get-stdout.ts';
import { gitStatusTracked } from '../utils/git.ts';
import { readJson } from '../utils/read-json.ts';

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
	reusedExistingCommit: boolean;
};

export type PackagePublicationDependency = {
	key: string;
	field: 'dependencies' | 'optionalDependencies';
	target: string;
};

const toPackageManagerGitUrl = (url: string) => {
	if (url.startsWith('git+')) {
		return url;
	}
	if (/^(?:file|git|https?|ssh):\/\//.test(url)) {
		return `git+${url}`;
	}
	const scpUrl = /^(?<user>[^@/:]+@)?(?<host>[^/:]+):(?<path>.+)$/.exec(url)?.groups;
	if (scpUrl) {
		return `git+ssh://${scpUrl.user ?? ''}${scpUrl.host}/${scpUrl.path}`;
	}
	return `git+file://${path.resolve(url)}`;
};

export const toInstallSpecifier = (fetchUrl: string, commit: string) => `${toPackageManagerGitUrl(fetchUrl)}#${commit}`;

export const preparePackagePublication = async ({
	packageName,
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
	const { scripts } = manifest;
	if (scripts && ('prepare' in scripts || 'prepack' in scripts)) {
		delete scripts.prepare;
		delete scripts.prepack;
	}
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
		reusedExistingCommit: tracked.length === 0,
	};
};
