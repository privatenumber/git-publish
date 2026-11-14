import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import packlist from 'npm-packlist';
import type { PackageManager } from './detect-package-manager.ts';
import { readJson } from './read-json.ts';
import { getStdout } from './get-stdout.ts';

const isNotEnoent = (error: unknown): boolean => !(
	typeof error === 'object'
	&& error !== null
	&& 'code' in error
	&& error.code === 'ENOENT'
);

const getPackArguments = async (
	packageManager: PackageManager,
	packDestinationDirectory: string,
	packOptions: SpawnOptions,
) => {
	if (packageManager === 'bun') {
		return ['pm', 'pack', '--destination', packDestinationDirectory];
	}

	if (packageManager === 'yarn') {
		// Yarn has no destination-directory flag: Yarn 2+ takes `--out`, Yarn 1 takes
		// `--filename`, and each rejects or ignores the other. Ask the Yarn that this
		// package resolves to (packageManager, yarnPath) which major it is.
		const tarballPath = path.join(packDestinationDirectory, 'package.tgz');
		const version = await getStdout(spawn('yarn', ['--version'], packOptions));
		return Number.parseInt(version, 10) >= 2
			? ['pack', '--out', tarballPath]
			: ['pack', '--filename', tarballPath];
	}

	return ['pack', '--pack-destination', packDestinationDirectory];
};

const listCandidates = async (cwd: string, packageRoot: string) => {
	const liveDirectoryExists = await fs.stat(cwd).then(() => true, (error: unknown) => {
		if (isNotEnoent(error)) { throw error; }
		return false;
	});
	if (!liveDirectoryExists) { return []; }
	const manifest = await readJson(path.join(packageRoot, 'package.json')) as Record<string, unknown>;
	delete manifest.bundleDependencies;
	delete manifest.bundledDependencies;
	// npm-packlist documents an Arborist tree; v11.3 reads only path, package,
	// isProjectRoot, edgesOut (bundled deps) and workspaces. A stub without bundled deps is enough.
	const [candidates, tracked] = await Promise.all([
		packlist({
			path: cwd,
			package: manifest,
			isProjectRoot: true,
			edgesOut: new Map(),
		}),
		spawn('git', ['ls-files', '-z'], { cwd }),
	]);
	const trackedPaths = new Set(tracked.stdout.split('\0'));
	return candidates.filter(candidate => !trackedPaths.has(candidate));
};

const copyContained = async (
	cwd: string,
	packWorktreePackageRoot: string,
	candidates: string[],
) => {
	const checkedDirectories = new Map<string, boolean>();
	const isSafeDirectory = async (directory: string): Promise<boolean> => {
		const cached = checkedDirectories.get(directory);
		if (cached !== undefined) { return cached; }
		if (directory !== packWorktreePackageRoot && !await isSafeDirectory(path.dirname(directory))) {
			checkedDirectories.set(directory, false);
			return false;
		}
		let safe = false;
		try {
			const stat = await fs.lstat(directory);
			safe = stat.isDirectory();
		} catch (error: unknown) {
			if (isNotEnoent(error)) { throw error; }
			await fs.mkdir(directory);
			safe = true;
		}
		checkedDirectories.set(directory, safe);
		return safe;
	};
	for (const relativePath of candidates) {
		const destinationPath = path.join(packWorktreePackageRoot, relativePath);
		if (!await isSafeDirectory(path.dirname(destinationPath))) { continue; }
		const source = path.join(cwd, relativePath);
		const stat = await fs.lstat(source);
		if (!stat.isFile()) { continue; }
		try {
			await fs.copyFile(source, destinationPath, constants.COPYFILE_EXCL);
			await fs.chmod(destinationPath, stat.mode);
		} catch (error: unknown) {
			if (!(error instanceof Error && 'code' in error && ['EEXIST', 'EISDIR', 'ENOTDIR'].includes(String(error.code)))) { throw error; }
		}
	}
};

export const packPackage = async (
	packageManager: PackageManager,
	packWorktreePath: string,
	packDestinationDirectory: string,
	cwd: string,
	gitRootPath: string,
	gitSubdirectory: string,
): Promise<string> => {
	await fs.mkdir(packDestinationDirectory, { recursive: true });
	const isMonorepo = gitSubdirectory.length > 0;
	const packWorktreePackageRoot = path.join(packWorktreePath, gitSubdirectory);
	const candidates = await listCandidates(cwd, packWorktreePackageRoot);
	await copyContained(cwd, packWorktreePackageRoot, candidates);

	// Symlink node_modules so hooks have access to dependencies
	// Note: Remove any existing node_modules directory in worktree first
	// (git might have checked it out)
	if (isMonorepo) {
		// Root node_modules
		const rootNodeModulesTarget = path.join(packWorktreePath, 'node_modules');
		await fs.rm(rootNodeModulesTarget, {
			recursive: true,
			force: true,
		});
		try {
			await fs.symlink(
				path.join(gitRootPath, 'node_modules'),
				rootNodeModulesTarget,
				'dir',
			);
		} catch (error: unknown) {
			// If node_modules doesn't exist, ignore (pack will likely fail later)
			if (isNotEnoent(error)) {
				throw error;
			}
		}

		// Package node_modules (if exists)
		const packageNodeModulesTarget = path.join(packWorktreePath, gitSubdirectory, 'node_modules');
		await fs.rm(packageNodeModulesTarget, {
			recursive: true,
			force: true,
		});
		try {
			await fs.symlink(
				path.join(cwd, 'node_modules'),
				packageNodeModulesTarget,
				'dir',
			);
		} catch (error: unknown) {
			if (isNotEnoent(error)) {
				throw error;
			}
		}
	} else {
		// Regular package node_modules
		const nodeModulesTarget = path.join(packWorktreePath, 'node_modules');
		await fs.rm(nodeModulesTarget, {
			recursive: true,
			force: true,
		});
		try {
			await fs.symlink(
				path.join(cwd, 'node_modules'),
				nodeModulesTarget,
				'dir',
			);
		} catch (error: unknown) {
			if (isNotEnoent(error)) {
				throw error;
			}
		}
	}

	// Run pack from the appropriate directory in pack worktree
	const packCwd = gitSubdirectory
		? path.join(packWorktreePath, gitSubdirectory)
		: packWorktreePath;
	const binaryPaths = new Set([
		path.join(cwd, 'node_modules', '.bin'),
		path.join(gitRootPath, 'node_modules', '.bin'),
		process.env.PATH,
	]);

	const packOptions = {
		cwd: packCwd,
		env: {
			PATH: [...binaryPaths].filter(pathEntry => pathEntry !== undefined).join(path.delimiter),
		},
	};
	const packArgs = await getPackArguments(packageManager, packDestinationDirectory, packOptions);
	await spawn(packageManager, packArgs, packOptions);

	// Find the generated tarball (package managers create it with their own naming)
	const files = await fs.readdir(packDestinationDirectory);
	const tarball = files.find(file => file.endsWith('.tgz'));

	if (!tarball) {
		throw new Error('No tarball found after pack');
	}

	return path.join(packDestinationDirectory, tarball);
};
