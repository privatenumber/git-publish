import semver from 'semver';

const { stringify } = JSON;

export type VersionSha = {
	version: string;
	gitHead: string;
};

/**
 * Build metadata, unlike a prerelease tag, keeps the version with its SHA inside
 * every range the source version satisfies.
 */
export const createVersionSha = (
	packageName: string,
	version: string | undefined,
	commit: string,
	shortCommit: string,
): VersionSha => {
	if (version === undefined) {
		return {
			version: `0.0.0+sha-${shortCommit}`,
			gitHead: commit,
		};
	}
	const parsed = semver.parse(version);
	if (!parsed) {
		throw new Error(`Package ${stringify(packageName)} has version ${stringify(version)}, which is not valid semver. --version-sha needs a semver version.`);
	}
	if (parsed.build.length > 0) {
		throw new Error(`Package ${stringify(packageName)} has version ${stringify(version)}, which already has build metadata. Remove it to use --version-sha.`);
	}
	const shaVersion = `${parsed.version}+sha-${shortCommit}`;
	// node-semver rejects versions longer than 256 characters.
	// semver.valid() drops build metadata, so parse instead.
	if (!semver.parse(shaVersion)) {
		throw new Error(`Package ${stringify(packageName)} would get version ${stringify(shaVersion)} with --version-sha, which is not valid semver. Versions can have at most 256 characters.`);
	}
	return {
		version: shaVersion,
		gitHead: commit,
	};
};

/**
 * The short source commit named by a well-formed version SHA on the same
 * base version as `versionSha`, or undefined.
 */
export const getVersionShaCommit = (
	versionSha: VersionSha,
	version: unknown,
	gitHead: unknown,
) => {
	if (typeof version !== 'string' || typeof gitHead !== 'string') {
		return undefined;
	}
	const parsed = semver.parse(version);
	if (!parsed || parsed.build.length !== 1 || parsed.version !== versionSha.version.split('+')[0]) {
		return undefined;
	}
	const shortCommit = /^sha-([\da-f]{4,})$/.exec(parsed.build[0]!)?.[1];
	return shortCommit
		&& /^(?:[\da-f]{40}|[\da-f]{64})$/.test(gitHead)
		&& gitHead.startsWith(shortCommit)
		? shortCommit
		: undefined;
};
