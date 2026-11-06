import semver from 'semver';

export const satisfiesWorkspaceRange = (version: string, range: string): boolean => (
	semver.satisfies(version, range, {
		includePrerelease: ['', '*', 'x'].includes(range.trim().toLowerCase()),
	})
);
