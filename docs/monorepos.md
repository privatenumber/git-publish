# Monorepos

`git-publish` publishes workspace packages together with the workspace packages they need, so the published package installs without a registry.

## Selecting packages

- **In a package directory:** publishes that package.
- **At the workspace root:** publishes every non-private member when the root `package.json` is private or unnamed. A named, public root publishes itself.
- **With arguments:** publishes the packages selected by name, directory, or quoted glob:

  ```sh
  git-publish @acme/core ./packages/adapter './packages/plugins/*'
  ```

Private workspace members are published without `--force`. `--force` is needed only for a private workspace root, which must also be selected, such as `git-publish . --force`. Without a selection, a private root publishes its non-private members.

## What gets published

A selection publishes the selected packages plus every workspace package they need at runtime or as a peer. Each package gets its own branch (see [Branches](./cli.md#branches)), and all branches are updated in one atomic push, so a failed branch update does not expose a partial set.

`git-publish` treats a dependency as internal when your package manager would link it to a workspace package:

- `workspace:` references, including aliases such as `workspace:core@*`. An explicit range, such as `workspace:^2.0.0`, must match the target's version.
- `file:` and `link:` paths to workspace packages.
- Plain semver runtime ranges whose range the workspace package's version satisfies: for npm and Bun always, for Yarn unless transparent workspaces are disabled, and for pnpm when `linkWorkspacePackages` is enabled (`true` or `deep`). Plain peer ranges are considered for every package manager.

In each published package, internal runtime dependencies are rewritten to commit-pinned Git URLs of the published packages. Internal peers keep their packed ranges.

Publication fails before pushing if:

- a packed peer range does not match its target's packed version,
- a packed dependency or peer still uses `workspace:`,
- or a lifecycle hook changed or added an internal dependency during packing. Hooks may remove internal dependencies.

A multi-package publication requires one push URL, because Git cannot atomically push one set of branches to several destinations. A single package can be pushed to several destinations in turn.

## Installing

After the push, `git-publish` prints one install command per selected package. It installs the package's whole set as root dependencies, each pinned to its publish commit, so every internal package resolves to exactly one copy. Packages reachable only through optional dependencies install transitively. See [Installing](./installing.md) for the settings consumers need.

## Preparing packages

Install the repository's dependencies before publishing so the package manager can resolve [`workspace:` references](https://pnpm.io/workspaces#workspace-protocol-workspace) and run package hooks. `git-publish` does not run a `build` script on its own.

If the repository has a workspace build command, run it first. For example, in a pnpm monorepo with a root `build` script and a remote named `fork` pointing to your fork:

```sh
# From the repository root
pnpm install
pnpm build
cd packages/my-lib
git-publish --remote fork
```

Build the selected package and all of its required workspace dependencies, and make sure each package's `files` field includes its build output.

If packages need custom preparation, add or adjust their `prepack` scripts in your fork. Each package can use its own command. Commit the manifest and source changes first: `git-publish` packs the committed source. Gitignored build output does not need to be committed.

Package hooks run in an isolated checkout that is cleaned between packages. Only the current package's ignored output matching its `files` field is copied from the source checkout, so a hook that needs a sibling's generated output must build it itself or use committed output.
