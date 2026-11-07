import semver from 'semver';

export const parseAliasedRange = (specification: string) => {
	const match = /^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(specification);
	return match
		? {
			target: match[1]!,
			range: match[2]!,
		}
		: undefined;
};

export const satisfiesWorkspaceRange = (version: string, range: string): boolean => (
	semver.satisfies(version, range, {
		includePrerelease: ['', '*'].includes(range.trim().toLowerCase()),
	})
);

export const satisfiesPackedPeer = (
	range: string,
	target: string,
	version: string,
): boolean => {
	const alias = parseAliasedRange(range);
	if (alias) {
		return alias.target === target && satisfiesWorkspaceRange(version, alias.range);
	}
	return satisfiesWorkspaceRange(version, range);
};
