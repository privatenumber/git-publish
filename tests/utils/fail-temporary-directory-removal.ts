import { fileURLToPath } from 'node:url';
import { createFixture } from 'fs-fixture';

const failRemovalScript = fileURLToPath(new URL('fail-temporary-directory-removal.mjs', import.meta.url));

/**
 * Make git-publish fail to remove its temporary directory. Pass `env` to `gitPublish()`.
 *
 * The directory it cannot remove is created in this fixture instead of the system temp
 * directory, so disposing the fixture deletes it.
 */
export const failTemporaryDirectoryRemoval = async () => {
	const temporaryDirectory = await createFixture();
	return Object.assign(temporaryDirectory, {
		env: {
			NODE_OPTIONS: `--import=${failRemovalScript}`,
			TMPDIR: temporaryDirectory.path,
		},
	});
};
