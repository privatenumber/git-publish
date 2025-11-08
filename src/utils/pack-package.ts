import path from 'node:path';
import fs from 'node:fs/promises';
import spawn from 'nano-spawn';
import type { PackageManager } from './detect-package-manager.js';
import { readJson } from './read-json.js';

const copyFileIfExists = async (source: string, destination: string): Promise<void> => {
	try {
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.copyFile(source, destination);
	} catch (error: any) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}
};

const copyDirectory = async (source: string, destination: string): Promise<void> => {
	await fs.mkdir(destination, { recursive: true });

	const entries = await fs.readdir(source, { withFileTypes: true });

	for (const entry of entries) {
		const sourcePath = path.join(source, entry.name);
		const destinationPath = path.join(destination, entry.name);

		if (entry.isDirectory()) {
			await copyDirectory(sourcePath, destinationPath);
		} else if (entry.isFile()) {
			await fs.copyFile(sourcePath, destinationPath);
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
	// Create temp directory for pack output
	await fs.mkdir(packDestinationDirectory, { recursive: true });

	// Determine if this is a monorepo package (in a subdirectory)
	const isMonorepo = gitSubdirectory.length > 0;

	// Copy gitignored files from user's directory if they're specified in files field
	// This handles cases where dist/ or other build artifacts are gitignored but need to be packed
	const packageJsonPath = path.join(cwd, 'package.json');
	const packageJson = await readJson(packageJsonPath) as { files?: string[] };

	if (packageJson.files) {
		const packWorktreePackageRoot = isMonorepo
			? path.join(packWorktreePath, gitSubdirectory)
			: packWorktreePath;

		for (const filePattern of packageJson.files) {
			const sourcePath = path.join(cwd, filePattern);
			const destinationPath = path.join(packWorktreePackageRoot, filePattern);

			try {
				const stats = await fs.stat(sourcePath);
				if (stats.isDirectory()) {
					// Copy entire directory
					await copyDirectory(sourcePath, destinationPath);
				} else if (stats.isFile()) {
					// Copy single file
					await copyFileIfExists(sourcePath, destinationPath);
				}
			} catch (error: any) {
				// File/directory doesn't exist in user's directory, skip it
				if (error.code !== 'ENOENT') {
					throw error;
				}
			}
		}
	}

	// Symlink node_modules so hooks have access to dependencies
	// Note: Remove any existing node_modules directory in worktree first (git might have checked it out)
	if (isMonorepo) {
		// Root node_modules
		const rootNodeModulesTarget = path.join(packWorktreePath, 'node_modules');
		await fs.rm(rootNodeModulesTarget, { recursive: true, force: true });
		try {
			await fs.symlink(
				path.join(gitRootPath, 'node_modules'),
				rootNodeModulesTarget,
				'dir',
			);
		} catch (error: any) {
			// If node_modules doesn't exist, ignore (pack will likely fail later)
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}

		// Package node_modules (if exists)
		const packageNodeModulesTarget = path.join(packWorktreePath, gitSubdirectory, 'node_modules');
		await fs.rm(packageNodeModulesTarget, { recursive: true, force: true });
		try {
			await fs.symlink(
				path.join(cwd, 'node_modules'),
				packageNodeModulesTarget,
				'dir',
			);
		} catch (error: any) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	} else {
		// Regular package node_modules
		const nodeModulesTarget = path.join(packWorktreePath, 'node_modules');
		await fs.rm(nodeModulesTarget, { recursive: true, force: true });
		try {
			await fs.symlink(
				path.join(cwd, 'node_modules'),
				nodeModulesTarget,
				'dir',
			);
		} catch (error: any) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	}

	// Determine pack command based on package manager
	const packArgs = packageManager === 'bun'
		? ['pm', 'pack', '--destination', packDestinationDirectory]
		: ['pack', '--pack-destination', packDestinationDirectory];

	// Run pack from the appropriate directory in pack worktree
	const packCwd = gitSubdirectory
		? path.join(packWorktreePath, gitSubdirectory)
		: packWorktreePath;

	await spawn(packageManager, packArgs, { cwd: packCwd });

	// Find the generated tarball (package managers create it with their own naming)
	const files = await fs.readdir(packDestinationDirectory);
	const tarball = files.find(file => file.endsWith('.tgz'));

	if (!tarball) {
		throw new Error('No tarball found after pack');
	}

	return path.join(packDestinationDirectory, tarball);
};
