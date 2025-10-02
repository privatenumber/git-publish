import path from 'node:path';
import fs from 'node:fs/promises';
import spawn from 'nano-spawn';
import type { PackageManager } from './detect-package-manager.js';

export const packPackage = async (
	packageManager: PackageManager,
	cwd: string,
	packDestinationDirectory: string,
): Promise<string> => {
	// Create temp directory for pack
	await fs.mkdir(packDestinationDirectory, { recursive: true });

	// Determine pack command based on package manager
	const packArgs = packageManager === 'bun'
		? ['pm', 'pack', '--destination', packDestinationDirectory]
		: ['pack', '--pack-destination', packDestinationDirectory];

	// Run pack from the current working directory
	await spawn(packageManager, packArgs, { cwd });

	// Find the generated tarball (package managers create it with their own naming)
	const files = await fs.readdir(packDestinationDirectory);
	const tarball = files.find(file => file.endsWith('.tgz'));

	if (!tarball) {
		throw new Error('No tarball found after pack');
	}

	return path.join(packDestinationDirectory, tarball);
};
