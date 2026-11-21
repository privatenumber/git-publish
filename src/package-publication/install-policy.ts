import npmPackageArg from 'npm-package-arg';
import type { PackageJson } from '@npmcli/package-json';
import type { PackageManager } from '../utils/detect-package-manager.ts';

export const getInstallPolicy = (
	manifest: PackageJson,
	packageManager: PackageManager,
) => {
	const dependencies = {
		...(packageManager === 'npm' && Object.fromEntries(
			Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => (
				!manifest.peerDependenciesMeta?.[name]?.optional
			)),
		)),
		...manifest.dependencies,
		...manifest.optionalDependencies,
	};
	const policy = {
		git: false,
		remote: false,
	};
	if (packageManager !== 'npm' && packageManager !== 'pnpm') {
		return policy;
	}
	for (const [name, specifier] of Object.entries(dependencies)) {
		if (typeof specifier !== 'string') {
			continue;
		}
		// pnpm's Git resolver also accepts plain ssh: URLs.
		const spec = packageManager === 'pnpm' && /^ssh:/i.test(specifier)
			? `git+${specifier}`
			: specifier;
		try {
			const { type } = npmPackageArg.resolve(name, spec);
			if (type === 'git' || type === 'remote') {
				policy[type] = true;
			}
		} catch {
			// This is install guidance, not validation of consumer dependency specs.
		}
	}
	return policy;
};
