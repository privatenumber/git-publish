import npmPackageArg from 'npm-package-arg';
import type { PackageJson } from '@npmcli/package-json';

/**
 * Whether npm needs --allow-remote=all for a direct HTTP(S) tarball URL in the
 * packed runtime, optional, or required peer dependencies.
 */
export const hasRemoteDependency = (manifest: PackageJson) => {
	const runtimeDependencies = {
		...manifest.dependencies,
		...manifest.optionalDependencies,
	};
	const dependencies = Object.entries(runtimeDependencies);
	for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
		// npm uses the runtime or optional edge when the same key is also a peer.
		if (
			!Object.hasOwn(runtimeDependencies, name)
			&& !manifest.peerDependenciesMeta?.[name]?.optional
		) {
			dependencies.push([name, specifier]);
		}
	}
	return dependencies.some(([name, specifier]) => {
		if (typeof specifier !== 'string') {
			return false;
		}
		try {
			return npmPackageArg.resolve(name, specifier).type === 'remote';
		} catch {
			// This is install guidance, not validation of consumer dependency specs.
			return false;
		}
	});
};
