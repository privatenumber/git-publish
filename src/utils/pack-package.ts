import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import spawn from 'nano-spawn';
import type { PackageManager } from './detect-package-manager.js';

const copyDirectory = async (source: string, destination: string, exclude?: string[]): Promise<void> => {
	await fs.mkdir(destination, { recursive: true });

	const entries = await fs.readdir(source, { withFileTypes: true });

	for (const entry of entries) {
		if (exclude?.includes(entry.name)) {
			continue;
		}

		const sourcePath = path.join(source, entry.name);
		const destinationPath = path.join(destination, entry.name);

		if (entry.isDirectory()) {
			// Recursively copy directories, passing exclude to skip node_modules at all levels
			await copyDirectory(sourcePath, destinationPath, exclude);
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			await fs.copyFile(sourcePath, destinationPath);
		}
	}
};

export const packPackage = async (
	packageManager: PackageManager,
	cwd: string,
	packDestinationDirectory: string,
	gitRootPath: string,
	gitSubdirectory: string,
): Promise<string> => {
	// Create temp directory for pack
	await fs.mkdir(packDestinationDirectory, { recursive: true });

	// Create isolated directory for running pack to prevent hooks from modifying user's files
	const isolatedPackDirectory = path.join(os.tmpdir(), `git-publish-pack-${Date.now()}-${process.pid}`);
	await fs.mkdir(isolatedPackDirectory, { recursive: true });

	// Determine if this is a monorepo package (in a subdirectory)
	const isMonorepo = gitSubdirectory.length > 0;

	try {
		if (isMonorepo) {
			// For monorepo packages, copy the entire git root so workspace files are accessible
			await copyDirectory(gitRootPath, isolatedPackDirectory, ['node_modules']);

			// Symlink node_modules from git root
			const nodeModulesPath = path.join(gitRootPath, 'node_modules');
			try {
				await fs.access(nodeModulesPath);
				await fs.symlink(
					nodeModulesPath,
					path.join(isolatedPackDirectory, 'node_modules'),
					'dir',
				);
			} catch {
				// node_modules doesn't exist, continue without it
			}

			// Also symlink node_modules in the package subdirectory if it exists
			const packageNodeModulesPath = path.join(cwd, 'node_modules');
			try {
				await fs.access(packageNodeModulesPath);
				await fs.symlink(
					packageNodeModulesPath,
					path.join(isolatedPackDirectory, gitSubdirectory, 'node_modules'),
					'dir',
				);
			} catch {
				// node_modules doesn't exist in package directory, continue without it
			}
		} else {
			// For regular packages, copy just the package directory
			await copyDirectory(cwd, isolatedPackDirectory, ['node_modules']);

			// Symlink node_modules so hooks have access to dependencies
			const nodeModulesPath = path.join(cwd, 'node_modules');
			try {
				await fs.access(nodeModulesPath);
				await fs.symlink(
					nodeModulesPath,
					path.join(isolatedPackDirectory, 'node_modules'),
					'dir',
				);
			} catch {
				// node_modules doesn't exist, continue without it
			}
		}

		// Determine pack command based on package manager
		const packArgs = packageManager === 'bun'
			? ['pm', 'pack', '--destination', packDestinationDirectory]
			: ['pack', '--pack-destination', packDestinationDirectory];

		// Run pack from the appropriate directory
		const packCwd = isMonorepo
			? path.join(isolatedPackDirectory, gitSubdirectory)
			: isolatedPackDirectory;

		await spawn(packageManager, packArgs, { cwd: packCwd });
	} finally {
		// Clean up isolated directory
		await fs.rm(isolatedPackDirectory, {
			recursive: true,
			force: true,
		});
	}

	// Find the generated tarball (package managers create it with their own naming)
	const files = await fs.readdir(packDestinationDirectory);
	const tarball = files.find(file => file.endsWith('.tgz'));

	if (!tarball) {
		throw new Error('No tarball found after pack');
	}

	return path.join(packDestinationDirectory, tarball);
};
