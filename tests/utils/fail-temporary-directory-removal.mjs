/**
 * Preloaded into the git-publish CLI with `--import` by `failTemporaryDirectoryRemoval()`.
 *
 * git-publish removes its temporary directory with `fs.rm(..., { force: true })`, which
 * practically never fails on its own. This makes that one call throw, so tests can check
 * that a failed cleanup neither hides the publication's own error nor turns a successful
 * publication into a failure. Every other `fs.rm` call goes to the real implementation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const remove = fs.rm;
fs.rm = async (target, options) => {
	if (path.basename(String(target)).startsWith('git-publish-')) {
		throw new Error(`Test cleanup failure at ${target}`);
	}
	return remove(target, options);
};
