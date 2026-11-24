import path from 'node:path';
import micromatch from 'micromatch';
import type { Workspace, WorkspacePackage } from './discover.ts';
import { findWorkspacePackageDirectory } from './graph.ts';

export type RootSelection = 'explicit' | 'public-root' | 'default-roots' | 'current-package';

const getRootSelection = (
	workspace: Workspace,
	cwd: string,
	selection: string[],
): RootSelection => {
	if (selection.length > 0) {
		return 'explicit';
	}
	if (path.resolve(cwd) !== path.resolve(workspace.rootDirectory)) {
		return 'current-package';
	}
	const { rootPackage } = workspace;
	return rootPackage?.name && !rootPackage.packageJson.private ? 'public-root' : 'default-roots';
};

const toPosixPath = (filePath: string) => filePath.split(path.sep).join('/');

// Each argument matches a package name or a directory glob relative to cwd
const matchExplicitRoots = (
	candidates: WorkspacePackage[],
	cwd: string,
	selection: string[],
) => {
	const roots = new Set<string>();
	for (const argument of selection) {
		const pattern = toPosixPath(path.resolve(cwd, argument));
		const matches = candidates.filter(candidate => candidate.name === argument
			|| micromatch.isMatch(toPosixPath(path.resolve(candidate.dir)), pattern));
		if (matches.length === 0) {
			throw new Error(`No workspace package matches ${JSON.stringify(argument)}.`);
		}
		for (const match of matches) {
			if (!match.name) {
				throw new Error('Cannot publish the selected workspace root because it has no name.');
			}
			roots.add(match.name);
		}
	}
	return roots;
};

const collectDefaultRoots = (workspace: Workspace, includePrivate: boolean | undefined) => {
	const roots = new Set<string>();
	const skippedPrivatePackages: string[] = [];
	for (const candidate of workspace.packages) {
		if (path.resolve(candidate.dir) === path.resolve(workspace.rootDirectory)) {
			continue;
		}
		// `private` keeps a package off registries; git-publish publishes it when chosen.
		// It is read only to choose what a root publish without arguments covers.
		if (!includePrivate && candidate.packageJson.private) {
			skippedPrivatePackages.push(candidate.name);
		} else {
			roots.add(candidate.name);
		}
	}
	return {
		roots,
		skippedPrivatePackages,
	};
};

/**
 * Chooses the packages to publish. Returns undefined when cwd is inside the workspace
 * but not inside any member, which publishes cwd as a standalone package.
 */
export const selectRoots = ({
	workspace, candidates, cwd, selection, includePrivate,
}: {
	workspace: Workspace;
	candidates: WorkspacePackage[];
	cwd: string;
	selection: string[];
	includePrivate: boolean | undefined;
}): {
	selection: RootSelection;
	roots: Set<string>;
	skippedPrivatePackages: string[];
} | undefined => {
	const rootSelection = getRootSelection(workspace, cwd, selection);
	switch (rootSelection) {
		case 'explicit': {
			return {
				selection: rootSelection,
				roots: matchExplicitRoots(candidates, cwd, selection),
				skippedPrivatePackages: [],
			};
		}
		case 'public-root': {
			return {
				selection: rootSelection,
				roots: new Set([workspace.rootPackage!.name]),
				skippedPrivatePackages: [],
			};
		}
		case 'default-roots': {
			return {
				selection: rootSelection,
				...collectDefaultRoots(workspace, includePrivate),
			};
		}
		case 'current-package': {
			const selectedPackage = findWorkspacePackageDirectory(workspace, cwd);
			return selectedPackage && {
				selection: rootSelection,
				roots: new Set([selectedPackage.name]),
				skippedPrivatePackages: [],
			};
		}
		default: {
			const unreachable: never = rootSelection;
			throw new Error(`Unknown selection mode: ${unreachable}`);
		}
	}
};
