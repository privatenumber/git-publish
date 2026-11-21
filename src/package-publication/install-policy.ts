import npmPackageArg from 'npm-package-arg';
import type { PackageJson } from '@npmcli/package-json';
import type { PackageManager } from '../utils/detect-package-manager.ts';

export const hasPolicyRestrictedSubdependencies = (
	manifest: PackageJson,
	packageManager: PackageManager,
) => {
	if (packageManager !== 'npm' && packageManager !== 'pnpm') {
		return false;
	}
	return Object.entries({
		...manifest.dependencies,
		...manifest.optionalDependencies,
	}).some(([name, specifier]) => {
		if (typeof specifier !== 'string') {
			return false;
		}
		// pnpm's Git resolver also accepts plain ssh: URLs.
		const spec = packageManager === 'pnpm' && /^ssh:/i.test(specifier)
			? `git+${specifier}`
			: specifier;
		try {
			const { type } = npmPackageArg.resolve(name, spec);
			// pnpm blocks both Git and HTTP tarball resolutions, but not local files.
			return type === 'git' || (packageManager === 'pnpm' && type === 'remote');
		} catch {
			// This is install guidance, not validation of consumer dependency specs.
			return false;
		}
	});
};
