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
| Preview the publication plan without packing, committing, or pushing | `npx git-publish --dry` |
| Publish to another remote, such as a fork | `npx git-publish --remote fork` or `--remote git@github.com:owner/repo.git` |
| Choose the branch | `npx git-publish --branch preview` or a template: `--branch 'preview/{package}'` (`{gitRef}`, `{gitSha}`, `{package}`) |
| Replace the branch history with one commit | `npx git-publish --fresh` (force-pushes) |
| Record the source commit in each published `package.json` (`version` gets `+sha-<commit>`, `gitHead` the full commit) | `npx git-publish --version-sha` |
| Get machine-readable results, such as for a PR comment | `npx git-publish --json result.json` |

`--fresh` rewrites the published branch, and an existing lockfile pinned to an old commit can stop installing once that commit is garbage-collected. Use it only when the user asks for it. Publishing requires Git read access to check for conflicting refs, even with `--fresh`. An applicable `pushInsteadOf` rule can send the push to a different repository from the one the check reads.

Choose a valid Git branch using ASCII letters, digits, and `. _ / @ -`. Do not start it with `refs/`, `heads/`, `tags/`, or `remotes/`. Avoid bare `@`, `HEAD` in any case, names made only of uppercase letters and underscores (such as `FETCH_HEAD`), and bare names of 7 to 64 hexadecimal digits. Names such as `npm/@` are valid. If the default name fails, use `--branch 'preview/{package}'` or `--branch 'preview/{gitSha}/{package}'`.

## Monorepos

- In a package directory: publishes that package plus every workspace package it needs at runtime or as a peer. Each package gets its own branch (default `npm/{gitRef}-{package}`), and all branches are pushed in one atomic push.
- At the workspace root: publishes every non-private member when the root `package.json` is private or unnamed and lists skipped private members. Pass `--force` to include them. A private root itself is not selected by default. A named public root publishes itself.
- Select packages explicitly by name, path, or quoted glob: `npx git-publish @acme/core ./packages/adapter './packages/plugins/*'`. A package named `skills` must be selected by path, because `skills` is a subcommand.
- Pass `--force` to publish a private package you select or a private workspace package that a selected package needs through a recognized internal dependency. An `npm:` alias that Yarn or Bun links to a private member is not detected ([alias experiment](https://github.com/privatenumber/git-publish/blob/develop/notes/git-publish/read-install-experiment.md)). At the workspace root without arguments, `--force` publishes every private member; select packages to limit it, such as `git-publish app --force`. `--dry` reports the same skips and errors without publishing.
- Every publication needs exactly one push URL. For multiple destinations, run once per destination with separate remotes or `--remote <url>`.

## Install a published package

After a push, git-publish prints the install command for the repository's package manager. Use it as printed:

- Install the selected package and its required internal peers with the printed command. Runtime dependencies install transitively. The package manager may skip optional workspace dependencies. Use the printed peer command to supply a missing peer when applicable. Both commands include any required npm or pnpm flags and use the same bare branch refs as the manifests, such as `npm i --allow-git=all 'owner/repo#npm/main'`. npm and pnpm commands always allow Git subdependencies, because the consumer's other dependencies may also be Git-published. npm's `--allow-remote=all` only covers direct tarball URLs in the published manifests; other packages' tarball dependencies can still need it.
- With Yarn Plug'n'Play and `pnpFallbackMode: none`, do not rely on a root install to supply a transitive peer. If `a` depends on `b` and `b` needs peer `c`, declare `c` as a peer of `a` too.
- Treat publish branches like a prerelease dist-tag. The lockfile pins commits. Update every channel package by its install key, including transitive dependencies. For unaliased dependencies, use commands such as `npm update app core`, `pnpm update app core`, `bun update app core`, or `yarn up -R app core`. If `app` declares `core` as `my-core`, use `npm update app my-core`, not `npm update app core`.
- When migrating from a commit-pinned publication, use the new commands to replace direct commit pins, then update by install key (`npm update app my-core` for the alias above). Do not add refs that a package manager could resolve instead of a publish branch, such as same-named tags.

Consumer settings the installing project needs:

| Package manager | Setting |
| --- | --- |
| npm 12+ | Save `allow-git=all` in the project's `.npmrc` to avoid `EALLOWGIT` on `npm ci`, clean installs, and updates. If the command includes `--allow-remote=all`, save `allow-remote=all` there too to avoid `EALLOWREMOTE`. |
| pnpm 11+ | Pass `--config.block-exotic-subdeps=false` again for updates or set `blockExoticSubdeps: false` in `pnpm-workspace.yaml`. Installs from the lockfile do not need it. |
| Yarn 4 | The repository in `approvedGitRepositories` in `.yarnrc.yml`, for every Git install. Yarn needs `name@url` arguments, which the printed command uses. Use HTTPS or SSH, not a local-file remote: Yarn 4.18.1 rejects `git+file:` URLs even when approved. |
| Bun | No Git dependency setting required |

For a private repository, the installing machine needs Git access to it (for GitHub: `gh auth setup-git`, or an `insteadOf` rewrite scoped to the owner). Do not put tokens in install URLs; git-publish strips credentials from every URL it writes or prints.

## Failures

| Message contains | Cause and fix |
| --- | --- |
| `working tree is not clean` | Commit or stash tracked changes first. |
| `marked as private` | The package is `private: true`. Pass `--force` only if the user intends to publish it. |
| `Cannot publish packages with workspace dependencies` | A standalone package outside a workspace declares `workspace:` dependencies. Run from the workspace, or bundle them. |
| `requires peer` or `in workspace range` | A packed peer range or explicit `workspace:` range does not match the target's version. Fix the range in the source manifest. |
| `changed during packing` or `has unresolved` | A lifecycle hook rewrote an internal dependency, or the packed manifest still contains a `workspace:` value. Hooks may remove internal dependencies but not change or add them. |
| `not valid semver` or `already has build metadata` | With `--version-sha`, the source version is not valid semver, already has `+...` build metadata, or would exceed node-semver's 256-character limit with the version SHA added. Fix the source `version`. |
| `changed the version` | With `--version-sha`, the packed version differs from the version with its SHA. Either a lifecycle script rewrote `version`, or the package manager's pack configuration packs a different manifest, such as pnpm `publishConfig.directory`. Stop the script from changing `version`, or publish without `--version-sha`. |
| `push URLs` | Every publication needs one push destination. Use separate remotes or `--remote <url>`, and run once per destination. |
| `"files" lists paths that were not published` (warning) | The build did not run or the entry is wrong. Build before publishing or fix `files`. |

## Report problems

Report bugs, wrong or missing guidance in this skill, confusing messages, and missing features at https://github.com/privatenumber/git-publish/issues. Search existing issues first, confirm the behavior with the latest release (`npx git-publish@latest`), and include a minimal reproduction without private code or URLs. Issues are posted under the user's identity, so draft the issue for the user's approval unless your instructions allow filing directly.
