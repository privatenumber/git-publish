import { getPackages, type Package } from '@manypkg/get-packages';
import type { PackageManager } from '../utils/detect-package-manager.ts';

export type WorkspacePackage = {
	name: string;
	dir: string;
	relativeDir: string;
	packageJson: Package['packageJson'];
};

export type Workspace = {
	rootDir: string;
	packageManager: PackageManager;
	packages: WorkspacePackage[];
};

const workspaceManagers: Record<string, PackageManager | undefined> = {
	npm: 'npm',
	pnpm: 'pnpm',
	yarn: 'yarn',
	bun: 'bun',
};

export const discoverWorkspacePackages = async (
	directory: string,
	packageManager: PackageManager,
): Promise<Workspace> => {
	const { tool, packages, rootDir } = await getPackages(directory);
	const discoveredManager = workspaceManagers[tool.type];
	if (!discoveredManager) {
		throw new Error(`Unsupported workspace type ${JSON.stringify(tool.type)} in ${rootDir}. Recursive publication supports npm, pnpm, yarn, and bun workspaces.`);
	}
	if (discoveredManager !== packageManager) {
		throw new Error(`Detected workspace type ${JSON.stringify(tool.type)} does not match the package manager ${JSON.stringify(packageManager)} detected from lockfiles in ${rootDir}.`);
	}
	return {
		rootDir,
		packageManager,
		packages: packages.map(({ packageJson, dir, relativeDir }) => ({
			name: packageJson.name,
			dir,
			relativeDir,
			packageJson,
		})),
	};
};
