import fs from 'node:fs/promises';
import { createFixture } from 'fs-fixture';

/**
 * Make git-publish fail to remove its temporary directories. Pass `nodeOptions` as
 * NODE_OPTIONS. Disposing removes the hook and the directories it kept.
 */
export const createCleanupFailureHook = async () => {
	const fixture = await createFixture({ 'kept-directories': '' });
	const keptDirectoriesPath = fixture.getPath('kept-directories');
	await fixture.writeFile('fail-cleanup.mjs', String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';

const remove = fs.rm;
fs.rm = async (target, options) => {
	if (path.basename(String(target)).startsWith('git-publish-')) {
		await fs.appendFile(${JSON.stringify(keptDirectoriesPath)}, target + '\n');
		throw new Error('Test cleanup failure at ' + target);
	}
	return remove(target, options);
};
`);

	return {
		nodeOptions: `--import=${fixture.getPath('fail-cleanup.mjs')}`,
		[Symbol.asyncDispose]: async () => {
			const keptDirectories = await fs.readFile(keptDirectoriesPath, 'utf8');
			await Promise.all(keptDirectories.split('\n').filter(Boolean).map(directory => fs.rm(directory, {
				recursive: true,
				force: true,
			})));
			await fixture.rm();
		},
	};
};
