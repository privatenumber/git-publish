import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Options as SpawnOptions } from 'nano-spawn';
import packlist from 'npm-packlist';
import PackageJson from '@npmcli/package-json';
import mapWorkspaces from '@npmcli/map-workspaces';
import type { PackageManager } from './detect-package-manager.ts';
import { getStdout } from './get-stdout.ts';
import { spawnAbortable } from './spawn-abortable.ts';

const hasErrorCode = (error: unknown, ...codes: string[]): boolean => (
	typeof error === 'object'
	&& error !== null
	&& 'code' in error
	&& codes.includes(String(error.code))
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
		const version = await getStdout(spawnAbortable('yarn', ['--version'], packOptions));
		return Number.parseInt(version, 10) >= 2
			? ['pack', '--out', tarballPath]
			: ['pack', '--filename', tarballPath];
	}

	return ['pack', '--pack-destination', packDestinationDirectory];
};

const listCandidates = async (cwd: string) => {
	const { content } = await PackageJson.normalize(cwd);
	delete content.bundleDependencies;
	delete content.bundledDependencies;
	const workspaces = content.workspaces
		? await mapWorkspaces({
			cwd,
			pkg: content,
		})
		: undefined;
	// This stub supplies the Arborist node fields npm-packlist reads.
	return packlist({
		path: cwd,
		package: content,
		isProjectRoot: true,
		edgesOut: new Map(),
		workspaces,
	});
};

const copyContained = async (
	cwd: string,
	packWorktreePackageRoot: string,
	candidates: string[],
	signal: AbortSignal,
) => {
	const checkedDirectories = new Map<string, boolean>();
	const isSafeDirectory = async (directory: string): Promise<boolean> => {
		const cached = checkedDirectories.get(directory);
		if (cached !== undefined) { return cached; }
		let safe = false;
		if (directory === packWorktreePackageRoot || await isSafeDirectory(path.dirname(directory))) {
			try {
				const stat = await fs.lstat(directory);
				safe = stat.isDirectory();
			} catch (error: unknown) {
				if (!hasErrorCode(error, 'ENOENT')) { throw error; }
				await fs.mkdir(directory);
				safe = true;
			}
		}
		checkedDirectories.set(directory, safe);
		return safe;
	};
	for (const relativePath of candidates) {
		signal.throwIfAborted();
		const destinationPath = path.join(packWorktreePackageRoot, relativePath);
		if (!await isSafeDirectory(path.dirname(destinationPath))) { continue; }
		const source = path.join(cwd, relativePath);
		const stat = await fs.lstat(source);
		if (!stat.isFile()) { continue; }
		try {
			await fs.copyFile(source, destinationPath, constants.COPYFILE_EXCL);
			await fs.chmod(destinationPath, stat.mode);
		} catch (error: unknown) {
			if (!hasErrorCode(error, 'EEXIST', 'EISDIR', 'ENOTDIR')) { throw error; }
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
	signal: AbortSignal,
): Promise<string> => {
	const isMonorepo = gitSubdirectory.length > 0;
	const packWorktreePackageRoot = path.join(packWorktreePath, gitSubdirectory);
	const checkoutRealPath = await fs.realpath(packWorktreePath);
	const missingDirectories: string[] = [];
	let ancestor = packWorktreePackageRoot;
	let ancestorRealPath: string;
	while (true) {
		try {
			ancestorRealPath = await fs.realpath(ancestor);
			break;
		} catch (error: unknown) {
			if (!hasErrorCode(error, 'ENOENT') || ancestor === packWorktreePath) { throw error; }
			missingDirectories.push(ancestor);
			ancestor = path.dirname(ancestor);
		}
	}
	const relativePackagePath = path.relative(checkoutRealPath, ancestorRealPath);
	if (relativePackagePath === '..' || relativePackagePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePackagePath)) {
		throw new Error(`Cannot pack ${gitSubdirectory || '.'}: the path leaves the isolated checkout through a symlink.`);
	}
	for (const directory of missingDirectories.reverse()) {
		await fs.mkdir(directory);
	}
	await fs.mkdir(packDestinationDirectory, { recursive: true });
	const candidates = await listCandidates(cwd);
	signal.throwIfAborted();
	await copyContained(cwd, packWorktreePackageRoot, candidates, signal);

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
			if (!hasErrorCode(error, 'ENOENT')) {
				throw error;
			}
		}

		// Package node_modules (if exists)
		const packageNodeModulesTarget = path.join(packWorktreePackageRoot, 'node_modules');
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
			if (!hasErrorCode(error, 'ENOENT')) {
				throw error;
			}
		}
	} else {
		// Regular package node_modules
		const nodeModulesTarget = path.join(packWorktreePackageRoot, 'node_modules');
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
			if (!hasErrorCode(error, 'ENOENT')) {
				throw error;
			}
		}
	}

	const binaryPaths = new Set([
		path.join(cwd, 'node_modules', '.bin'),
		path.join(gitRootPath, 'node_modules', '.bin'),
		process.env.PATH,
	]);

	const packOptions = {
		cwd: packWorktreePackageRoot,
		signal,
		env: {
			PATH: [...binaryPaths].filter(pathEntry => pathEntry !== undefined).join(path.delimiter),
		},
	};
	const packArgs = await getPackArguments(packageManager, packDestinationDirectory, packOptions);
	signal.throwIfAborted();
	await spawnAbortable(packageManager, packArgs, packOptions, { processGroup: true });

	// Find the generated tarball (package managers create it with their own naming)
	const files = await fs.readdir(packDestinationDirectory);
	const tarball = files.find(file => file.endsWith('.tgz'));

	if (!tarball) {
		throw new Error('No tarball found after pack');
	}

	return path.join(packDestinationDirectory, tarball);
};
