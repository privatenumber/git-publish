import { describe, onFinish } from 'manten';
import { isolateEnvironment } from './utils/isolate-environment.ts';

describe('git-publish', async () => {
	const home = await isolateEnvironment();
	onFinish(() => home.rm());

	// The signal spec awaits its tests before the other specs start spawning Git and npm.
	await import('./specs/signals.ts');
	import('./specs/skills.ts');
	import('./specs/workspace-discovery.ts');
	import('./specs/workspace-publication.ts');
	import('./specs/package-publication.ts');
	import('./specs/branch-template.ts');
	import('./specs/standalone-branch-template.ts');
	import('./specs/publish-graph.ts');
	import('./specs/github-remotes.ts');
	import('./specs/error.ts');
	import('./specs/git-config.ts');
	import('./specs/validation-errors.ts');
	import('./specs/remote-transport.ts');
	import('./specs/publish-history.ts');
	import('./specs/package-managers.ts');
	import('./specs/package-contents.ts');
	import('./specs/lifecycle-hooks.ts');
});
