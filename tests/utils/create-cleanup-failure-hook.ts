import type { FsFixture } from 'fs-fixture';

export const createCleanupFailureHook = async (fixture: FsFixture) => {
	const hookPath = fixture.getPath('fail-cleanup.mjs');
	await fixture.writeFile('fail-cleanup.mjs', `
import fs from 'node:fs/promises';
import path from 'node:path';

const remove = fs.rm;
fs.rm = async (target, options) => {
	if (path.basename(String(target)).startsWith('git-publish-')) {
		// Remove the directory, then fail, so git-publish reports the failure without leaking it
		await remove(target, options);
		throw new Error('Test cleanup failure at ' + target);
	}
	return remove(target, options);
};
`);
	return `--import=${hookPath}`;
};
