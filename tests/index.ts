import { describe, onFinish } from 'manten';
import { isolateEnvironment } from './utils/isolate-environment.ts';
import { specConcurrency } from './utils/test-concurrency.ts';

const specs = [
	'./specs/skills.ts',
	'./specs/workspace-discovery.ts',
	'./specs/workspace-publication.ts',
	'./specs/package-publication.ts',
	'./specs/branch-template.ts',
	'./specs/standalone-branch-template.ts',
	'./specs/publish-graph.ts',
	'./specs/github-remotes.ts',
	'./specs/error.ts',
	'./specs/git-config.ts',
	'./specs/validation-errors.ts',
	'./specs/remote-transport.ts',
	'./specs/publish-history.ts',
	'./specs/package-managers.ts',
	'./specs/package-contents.ts',
	'./specs/lifecycle-hooks.ts',
];

describe('git-publish', async () => {
	const home = await isolateEnvironment();
	onFinish(() => home.rm());

	// The signal spec awaits its tests before the other specs start spawning Git and npm.
	await import('./specs/signals.ts');

	// Each spec awaits its groups, so an import settles when the spec's tests finish.
	// manten's parallel option would not work here: a limited group can finish while
	// child groups still wait for a slot.
	const queue = specs.values();
	await Promise.all(Array.from({ length: specConcurrency }, async () => {
		for (const spec of queue) {
			await import(spec);
		}
	}));
});
