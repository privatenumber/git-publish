import semver from 'semver';

const { stringify } = JSON;

export type CommitStamp = {
	version: string;
	gitHead: string;
};

/**
 * Build metadata, unlike a prerelease tag, keeps the stamped version inside
 * every range the source version satisfies.
 */
export const createCommitStamp = (
	packageName: string,
	version: string | undefined,
	commit: string,
	shortCommit: string,
): CommitStamp => {
	if (version === undefined) {
		return {
			version: `0.0.0+sha-${shortCommit}`,
			gitHead: commit,
		};
	}
	const parsed = semver.parse(version);
	if (!parsed) {
		throw new Error(`Package ${stringify(packageName)} has version ${stringify(version)}, which is not valid semver. --stamp-commit needs a semver version.`);
	}
	if (parsed.build.length > 0) {
		throw new Error(`Package ${stringify(packageName)} has version ${stringify(version)}, which already has build metadata. Remove it to use --stamp-commit.`);
	}
	const stamped = `${parsed.version}+sha-${shortCommit}`;
	// node-semver rejects versions longer than 256 characters.
	// semver.valid() drops build metadata, so parse instead.
	if (!semver.parse(stamped)) {
		throw new Error(`Package ${stringify(packageName)} would get stamped version ${stringify(stamped)}, which is not valid semver. Versions can have at most 256 characters.`);
	}
	return {
		version: stamped,
		gitHead: commit,
	};
};

/**
 * The short source commit named by a well-formed commit stamp on the same
 * base version as `stamp`, or undefined.
 */
export const getStampedCommit = (
	stamp: CommitStamp,
	version: unknown,
	gitHead: unknown,
) => {
	if (typeof version !== 'string' || typeof gitHead !== 'string') {
		return undefined;
	}
	const parsed = semver.parse(version);
	if (!parsed || parsed.build.length !== 1 || parsed.version !== stamp.version.split('+')[0]) {
		return undefined;
	}
	const shortCommit = /^sha-([\da-f]{4,})$/.exec(parsed.build[0]!)?.[1];
	return shortCommit
		&& /^(?:[\da-f]{40}|[\da-f]{64})$/.test(gitHead)
		&& gitHead.startsWith(shortCommit)
		? shortCommit
		: undefined;
};
