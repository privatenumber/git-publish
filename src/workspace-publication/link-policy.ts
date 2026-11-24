import path from 'node:path';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import type { PackageManager } from '../utils/detect-package-manager.ts';

const readOptionalFile = (filePath: string) => fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
	if (error.code === 'ENOENT') {
		return '';
	}
	throw error;
});

const readYarnTransparentWorkspaces = async (rootDirectory: string) => {
	// Parsed even when the environment overrides it, so an unreadable file still fails planning
	const yarnSettings = yaml.load(await readOptionalFile(path.join(rootDirectory, '.yarnrc.yml'))) as
		| { enableTransparentWorkspaces?: boolean }
		| undefined;
	const yarnEnvironment = process.env.YARN_ENABLE_TRANSPARENT_WORKSPACES;
	return yarnEnvironment === undefined
		? yarnSettings?.enableTransparentWorkspaces !== false
		: !['false', '0'].includes(yarnEnvironment.toLowerCase());
};

const readPnpmLinkWorkspacePackages = async (rootDirectory: string) => {
	const workspaceConfig = (yaml.load(await fs.readFile(path.join(rootDirectory, 'pnpm-workspace.yaml'), 'utf8')) ?? {}) as {
		linkWorkspacePackages?: boolean | string;
		'link-workspace-packages'?: boolean | string;
	};
	const npmrc = await readOptionalFile(path.join(rootDirectory, '.npmrc'));
	const configured = process.env.PNPM_CONFIG_LINK_WORKSPACE_PACKAGES
		?? process.env.npm_config_link_workspace_packages
		?? workspaceConfig.linkWorkspacePackages
		?? workspaceConfig['link-workspace-packages']
		?? /^\s*link-workspace-packages\s*=\s*(\S+)\s*$/m.exec(npmrc)?.[1];
	return configured === true || configured === 'true' || configured === 'deep';
};

/**
 * Whether a plain semver range, such as `^1.0.0`, links to a matching workspace package
 * instead of resolving from the registry.
 */
export const readPlainRangesPolicy = async (
	packageManager: PackageManager,
	rootDirectory: string,
): Promise<boolean> => {
	if (packageManager === 'pnpm') {
		return readPnpmLinkWorkspacePackages(rootDirectory);
	}
	if (packageManager === 'yarn') {
		return readYarnTransparentWorkspaces(rootDirectory);
	}
	return true;
};
