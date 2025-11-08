import path from 'node:path';
import fs from 'node:fs/promises';
import spawn from 'nano-spawn';
import glob from 'fast-glob';
import type { PackageManager } from './detect-package-manager.js';
import { readJson } from './read-json.js';

const copyFile = async (source: string, destination: string): Promise<void> => {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.copyFile(source, destination);
};

const isNotEnoent = (error: unknown): boolean => (
	typeof error === 'object'
	&& error !== null
	&& 'code' in error
	&& error.code !== 'ENOENT'
);

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

	if (packageJson.files && packageJson.files.length > 0) {
		const packWorktreePackageRoot = isMonorepo
			? path.join(packWorktreePath, gitSubdirectory)
			: packWorktreePath;

		// Transform directory entries to glob patterns
		// npm/pnpm treat 'dist' as 'dist/**', but fast-glob needs explicit patterns
		const patterns = await Promise.all(
			packageJson.files.map(async (entry) => {
				const fullPath = path.join(cwd, entry);
				try {
					const stats = await fs.stat(fullPath);
					// If it's a directory, expand to recursive pattern
					return stats.isDirectory() ? `${entry}/**` : entry;
				} catch (error: unknown) {
					// Only catch ENOENT (file not found) - treat as glob pattern
					// Re-throw other errors like EPERM (permission denied)
					if (isNotEnoent(error)) {
						throw error;
					}
					return entry;
				}
			}),
		);

		// Use fast-glob to resolve patterns in files field
		// This handles glob patterns like "dist/*.js", directories like "dist", and dotfiles
		const matchedFiles = await glob(patterns, {
			cwd,
			dot: true, // Include dotfiles like .env.production
			gitignore: false, // Include gitignored files (they may be built artifacts we need to pack)
		});

		// Copy all matched files to pack worktree
		for (const relativePath of matchedFiles) {
			const sourcePath = path.join(cwd, relativePath);
			const destinationPath = path.join(packWorktreePackageRoot, relativePath);

			await copyFile(sourcePath, destinationPath);
		}
	}

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
