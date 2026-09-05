import { describe } from 'manten';

describe('git-publish', () => {
	import('./specs/workspace-discovery.ts');
	import('./specs/workspace-publication.ts');
	import('./specs/package-publication.ts');
	import('./specs/branch-template.ts');
	import('./specs/standalone-branch-template.ts');
	import('./specs/run-graph.ts');
	import('./specs/publish-graph.ts');
	import('./specs/github-remotes.ts');
	import('./specs/git-config.ts');
	import('./specs/validation-errors.ts');
	import('./specs/remote-transport.ts');
	import('./specs/publish-history.ts');
	import('./specs/package-managers.ts');
	import('./specs/package-contents.ts');
	import('./specs/lifecycle-hooks.ts');
});
