import path from 'node:path';
import { getPackages, type Package } from '@manypkg/get-packages';
import {
	BunTool, NpmTool, PnpmTool, YarnTool, type Tool,
} from '@manypkg/tools';
import type { PackageManager } from '../utils/detect-package-manager.ts';

export type WorkspacePackage = {
	name: string;
	dir: string;
	packageJson: Package['packageJson'];
};

export type Workspace = {
	packages: WorkspacePackage[];
};

// Manypkg checks tools in its own precedence order (yarn before pnpm, npm,
// and bun), which differs from lockfile-based detection. Passing only the
// matching tool constrains discovery to the detected manager instead of
// verifying after the fact, so mixed markers such as a stale yarn.lock in a
// pnpm workspace cannot select the wrong tool.
const workspaceTools: Record<PackageManager, Tool> = {
	npm: NpmTool,
	pnpm: PnpmTool,
	yarn: YarnTool,
	bun: BunTool,
};

const findWorkspaceRoot = async (
	directory: string,
	packageManager: PackageManager,
	boundaryDirectory: string,
): Promise<string | undefined> => {
	const tool = workspaceTools[packageManager];
	const boundary = path.resolve(boundaryDirectory);
	let candidate = path.resolve(directory);
	while (true) {
		if (await tool.isMonorepoRoot(candidate)) {
			return candidate;
		}
		if (candidate === boundary) {
			return undefined;
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) {
			return undefined;
		}
		candidate = parent;
	}
};

export const discoverWorkspacePackages = async (
	directory: string,
	packageManager: PackageManager,
): Promise<Workspace> => {
	const tool = workspaceTools[packageManager];
	const options = { tools: [tool] };
	const { packages } = await getPackages(directory, options).catch((error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`No ${packageManager} workspace found in ${directory}: ${reason}`);
	});
	return {
		packages: packages.map(({ packageJson, dir }) => ({
			name: packageJson.name,
			dir,
			packageJson,
		})),
	};
};

export const findWorkspacePackages = async (
	directory: string,
	packageManager: PackageManager,
	boundaryDirectory = directory,
): Promise<Workspace | undefined> => {
	const rootDirectory = await findWorkspaceRoot(directory, packageManager, boundaryDirectory);
	if (!rootDirectory) {
		return undefined;
	}
	return discoverWorkspacePackages(rootDirectory, packageManager);
};
