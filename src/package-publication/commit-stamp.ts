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
	return {
		version: `${parsed.version}+sha-${shortCommit}`,
		gitHead: commit,
	};
};

/**
 * Whether a published version and gitHead form a commit stamp on the same
 * base version as `stamp`.
 */
export const isCommitStampOf = (
	stamp: CommitStamp,
	version: unknown,
	gitHead: unknown,
) => {
	if (typeof version !== 'string' || typeof gitHead !== 'string') {
		return false;
	}
	const parsed = semver.parse(version);
	const build = parsed?.build;
	return build?.length === 1
		&& build[0]!.startsWith('sha-')
		&& gitHead.startsWith(build[0]!.slice(4))
		&& version.slice(0, version.indexOf('+')) === stamp.version.slice(0, stamp.version.indexOf('+'));
};
