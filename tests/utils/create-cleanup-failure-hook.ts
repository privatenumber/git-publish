import { createFixture } from 'fs-fixture';

/**
 * Make git-publish fail to remove its temporary directories. Pass `nodeOptions` as
 * NODE_OPTIONS. The hook still removes each directory before it throws, so nothing leaks.
 */
export const createCleanupFailureHook = async () => {
	const fixture = await createFixture({
		'fail-cleanup.mjs': `
import fs from 'node:fs/promises';
import path from 'node:path';

const remove = fs.rm;
fs.rm = async (target, options) => {
	if (path.basename(String(target)).startsWith('git-publish-')) {
		await remove(target, options);
		throw new Error('Test cleanup failure at ' + target);
	}
	return remove(target, options);
};
`,
	});

	return Object.assign(fixture, {
		nodeOptions: `--import=${fixture.getPath('fail-cleanup.mjs')}`,
	});
};
