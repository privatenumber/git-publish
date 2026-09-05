import type { PackagePublication } from '../package-publication/prepare.ts';
import type { PackageManager } from './detect-package-manager.ts';
import { getGitHubInstallSpecifier } from './github.ts';

export const formatInstallCommand = (
	packageManager: PackageManager,
	remoteUrl: string,
	publication: PackagePublication,
	revision: string,
) => `${packageManager} i '${getGitHubInstallSpecifier(remoteUrl, revision) ?? publication.installSpecifier}'`;
