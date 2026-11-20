---
name: git-publish
description: Publishing an npm package or monorepo workspace packages to a Git branch with git-publish, installing a package from a branch published by git-publish, or running `git-publish`, `npx git-publish`, or `pnpm dlx git-publish`.
---

# git-publish

This skill covers publishing npm packages to Git branches with git-publish and installing them. Full documentation: https://github.com/privatenumber/git-publish/tree/develop/docs

## Publish

Preconditions: run inside a Git repository with a clean tracked working tree (`git status --porcelain --untracked-files=no` is empty); git-publish packs the committed source, so uncommitted or stashed edits are not published. Commit edits the user wants included. Install the repository's dependencies first, and run its build when the package's `prepack` does not build. Gitignored build output that matches the package's `files` field is included.

| Goal | Command |
| --- | --- |
| Publish the package in the current directory to `npm/<branch>` on `origin` | `npx git-publish` |
| Preview without committing or pushing | `npx git-publish --dry` |
| Publish to another remote, such as a fork | `npx git-publish --remote fork` or `--remote git@github.com:owner/repo.git` |
| Choose the branch | `npx git-publish --branch preview` or a template: `--branch 'preview/{package}'` (`{gitRef}`, `{gitSha}`, `{package}`) |
| Replace the branch history with one commit | `npx git-publish --fresh` (force-pushes) |
| Record the source commit in each published `package.json` (`version` gets `+sha-<commit>`, `gitHead` the full commit) | `npx git-publish --stamp-commit` |
| Get machine-readable results, such as for a PR comment | `npx git-publish --json result.json` |

`--fresh` rewrites the published branch, and an existing lockfile pinned to an old commit can stop installing once that commit is garbage-collected. Use it only when the user asks for it.

## Monorepos

- In a package directory: publishes that package plus every workspace package it needs at runtime or as a peer. Each package gets its own branch (default `npm/{gitRef}-{package}`), and all branches are pushed in one atomic push.
- At the workspace root: publishes every non-private member when the root `package.json` is private or unnamed; a named public root publishes itself.
- Select packages explicitly by name, path, or quoted glob: `npx git-publish @acme/core ./packages/adapter './packages/plugins/*'`. A package named `skills` must be selected by path, because `skills` is a subcommand.
- Private workspace members are published without `--force`; `--force` is only for a private standalone package, or a publication that includes a private workspace root.
- Every publication needs exactly one push URL. For multiple destinations, run once per destination with separate remotes or `--remote <url>`.

## Install a published package

After a push, git-publish prints the install command for the repository's package manager. Use it as printed:

- A package without internal dependencies uses the moving branch, such as `npm i 'owner/repo#npm/main'`. A lockfile pins the commit; run the package manager's update command (`npm update <name>`, `pnpm update <name>`, `bun update <name>`, `yarn up -R <name>`) to move to a newer publish.
- A package with internal dependencies prints one command that installs the whole set as root dependencies, each pinned to its publish commit. Install every listed argument together; installing only the selected package needs broader consumer settings. Upgrading means running the newly printed command.

Consumer settings the installing project needs:

| Package manager | Setting |
| --- | --- |
| npm 12+ | `--allow-git=root` on the install command, or `allow-git=root` in `.npmrc`. Optional transitive Git dependencies need `allow-git=all`. |
| pnpm 11+ | `blockExoticSubdeps: false` in `pnpm-workspace.yaml` when the install set has more than one package |
| Yarn 4 | The repository in `approvedGitRepositories` in `.yarnrc.yml`, for every Git install. Yarn needs `name@url` arguments, which the printed command uses. |

For a private repository, the installing machine needs Git access to it (for GitHub: `gh auth setup-git`, or an `insteadOf` rewrite scoped to the owner). Do not put tokens in install URLs; git-publish strips credentials from every URL it writes or prints.

## Failures

| Message contains | Cause and fix |
| --- | --- |
| `working tree is not clean` | Commit or stash tracked changes first. |
| `marked as private` | Standalone or workspace-root package is `private: true`. Pass `--force` only if the user intends to publish it. |
| `Cannot publish packages with workspace dependencies` | A standalone package outside a workspace declares `workspace:` dependencies. Run from the workspace, or bundle them. |
| `requires peer` or `in workspace range` | A packed peer range or explicit `workspace:` range does not match the target's version. Fix the range in the source manifest. |
| `changed during packing` or `has unresolved` | A lifecycle hook rewrote an internal dependency, or the packed manifest still contains a `workspace:` value. Hooks may remove internal dependencies but not change or add them. |
| `not valid semver` or `already has build metadata` | With `--stamp-commit`, the source version is not valid semver, already has `+...` build metadata, or would exceed node-semver's 256-character limit once stamped. Fix the source `version`. |
| `changed the version` | With `--stamp-commit`, the packed version differs from the stamp. Either a lifecycle script rewrote `version`, or the package manager's pack configuration packs a different manifest, such as pnpm `publishConfig.directory`. Stop the script from changing `version`, or publish without `--stamp-commit`. |
| `push URLs` | Every publication needs one push destination. Use separate remotes or `--remote <url>`, and run once per destination. |
| `"files" lists paths that were not published` (warning) | The build did not run or the entry is wrong. Build before publishing or fix `files`. |

## Report problems

Report bugs, wrong or missing guidance in this skill, confusing messages, and missing features at https://github.com/privatenumber/git-publish/issues. Search existing issues first, confirm the behavior with the latest release (`npx git-publish@latest`), and include a minimal reproduction without private code or URLs. Issues are posted under the user's identity, so draft the issue for the user's approval unless your instructions allow filing directly.
