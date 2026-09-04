import { describe } from 'manten';

describe('git-publish', () => {
	import('./specs/github-remotes.ts');
	import('./specs/git-config.ts');
	import('./specs/validation-errors.ts');
	import('./specs/remote-transport.ts');
	import('./specs/publish-history.ts');
	import('./specs/package-managers.ts');
	import('./specs/package-contents.ts');
	import('./specs/lifecycle-hooks.ts');
});
