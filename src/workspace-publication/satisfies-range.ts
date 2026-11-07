import semver from 'semver';

export const satisfiesWorkspaceRange = (version: string, range: string): boolean => (
	semver.satisfies(version, range, {
		includePrerelease: ['', '*'].includes(range.trim().toLowerCase()),
	})
);

// pnpm packs an aliased workspace peer as `npm:<target>@<range>`
const aliasedRangePattern = /^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/;

export const satisfiesPackedPeer = (
	range: string,
	target: string,
	version: string,
): boolean => {
	const alias = range.match(aliasedRangePattern);
	if (alias) {
		return alias[1] === target && satisfiesWorkspaceRange(version, alias[2]!);
	}
	return satisfiesWorkspaceRange(version, range);
};
