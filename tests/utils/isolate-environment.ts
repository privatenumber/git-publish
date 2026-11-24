import { createFixture } from 'fs-fixture';

// Settings that the developer's shell or `pnpm test` can pass to every child process.
// PNPM_HOME stays because it locates the installed pnpm, not its configuration.
const inheritedSetting = /^(?:GIT_|npm_|pnpm_|yarn_|bun_)|^NODE_(?:OPTIONS|PATH)$/i;

/**
 * Give every process the suite spawns a temporary home, so the developer's global Git,
 * npm, pnpm, Yarn, and Bun configuration and caches cannot change the results.
 *
 * nano-spawn merges its `env` option into `process.env`, and specs also spawn
 * Git directly, so this changes `process.env` itself.
 */
export const isolateEnvironment = async () => {
	const home = await createFixture({ '.gitconfig': '' });

	for (const key of Object.keys(process.env)) {
		if (inheritedSetting.test(key) && key !== 'PNPM_HOME') {
			delete process.env[key];
		}
	}

	Object.assign(process.env, {
		HOME: home.path,
		XDG_CONFIG_HOME: home.getPath('.config'),
		XDG_CACHE_HOME: home.getPath('.cache'),
		XDG_DATA_HOME: home.getPath('.local/share'),
		XDG_STATE_HOME: home.getPath('.local/state'),
	});

	return home;
};
