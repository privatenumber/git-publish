import npmPackageArg from 'npm-package-arg';
import type { PackageJson } from '@npmcli/package-json';
import type { PackageManager } from '../utils/detect-package-manager.ts';

export const getInstallPolicy = (
	manifest: PackageJson,
	packageManager: PackageManager,
) => {
	const runtimeDependencies = {
		...manifest.dependencies,
		...manifest.optionalDependencies,
	};
	const dependencies = Object.entries(runtimeDependencies);
	const policy = {
		git: [] as [name: string, specifier: string][],
		remote: false,
	};
	if (packageManager !== 'npm' && packageManager !== 'pnpm') {
		return policy;
	}
	if (packageManager === 'npm') {
		for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
			if (
				!Object.hasOwn(runtimeDependencies, name)
				&& !manifest.peerDependenciesMeta?.[name]?.optional
			) {
				dependencies.push([name, specifier]);
			}
		}
	}
	for (const [name, specifier] of dependencies) {
		if (typeof specifier !== 'string') {
			continue;
		}
		// pnpm's Git resolver also accepts plain ssh: URLs.
		const spec = packageManager === 'pnpm' && /^ssh:/i.test(specifier)
			? `git+${specifier}`
			: specifier;
		try {
			const { type } = npmPackageArg.resolve(name, spec);
			if (type === 'git') {
				policy.git.push([name, specifier]);
			} else if (type === 'remote') {
				policy.remote = true;
			}
		} catch {
			// This is install guidance, not validation of consumer dependency specs.
		}
	}
	return policy;
};
