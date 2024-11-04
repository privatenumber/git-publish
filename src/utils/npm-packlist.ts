import packlist from 'npm-packlist';
import type { PackageJson } from '@npmcli/package-json';

// Only to silence types
const edgesOut = new Map();

export const getNpmPacklist = (
	absoluteLinkPackagePath: string,
	packageJson: PackageJson,
) => (
	// @ts-expect-error we're passing in the minimum number of properties needed
	packlist({
		path: absoluteLinkPackagePath,
		package: packageJson,
		edgesOut,
	})
);
