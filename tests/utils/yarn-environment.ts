import path from 'node:path';
import fs from 'node:fs/promises';
import type { createFixture } from 'fs-fixture';

export const createYarnEnvironment = async (
	commands: Awaited<ReturnType<typeof createFixture>>,
	{ isolatedCache = false }: { isolatedCache?: boolean } = {},
) => {
	await commands.writeFile('yarn', `#!/bin/sh\nexec "${process.execPath}" "${path.resolve('node_modules/yarn-berry/bin/yarn.js')}" "$@"\n`);
	await fs.chmod(commands.getPath('yarn'), 0o755);
	return {
		PATH: `${commands.path}${path.delimiter}${process.env.PATH}`,
		YARN_ENABLE_TELEMETRY: '0',
		// Yarn 4 enables immutable installs under CI; the fixture install creates the lockfile
		YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
		...(isolatedCache && {
			YARN_GLOBAL_FOLDER: commands.getPath('yarn-global'),
			YARN_CACHE_FOLDER: commands.getPath('yarn-cache'),
		}),
	};
};
