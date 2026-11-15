# Cost of workspace closure publication

**Decision.** Keep publishing workspace closures. Removing them would drop documented monorepo features, and the hardest code, detecting which dependencies are internal, would have to stay to refuse unsupported packages. A measurement spike against commit `56fbac1` estimated the saving at about 17% of `src/`. Decided 2026-11-15.

## What closure publication is

When a selected workspace package depends on other workspace packages, git-publish publishes the closure of internal dependencies it recognizes in the packed manifests (a pack hook can remove one): each package on its own branch, internal runtime dependencies rewritten to commit-pinned Git URLs (peer ranges are kept), all branches in one atomic push, and an install set for each selected package ([monorepo install sets](./monorepo-install-sets.md)). Recognition has known gaps, such as `npm:` aliases to workspace packages under Yarn and Bun ([#110](https://github.com/privatenumber/git-publish/issues/110)). The spike asked how much code remains if git-publish publishes exactly one package per run and refuses packages with internal runtime dependencies or internal peers.

## Method

A throwaway branch kept internal-dependency detection, added the refusal error, rejected selecting more than one package, and deleted the code that became unreachable: closure traversal, install sets and their output, multi-branch atomic push, dependency rewriting and pinning, peer-range validation, and packed-manifest edge validation. Line counts use `wc -l` on regular files, including blank lines and comments.

The spike was never committed and no longer exists, so only the before counts can be reproduced (from `56fbac1`). Treat the after counts as an estimate. The decision does not depend on their exact values: the detection point below can be checked against the current source.

## Results

| Directory | Before | After |
| --- | ---: | ---: |
| `src/` (top level) | 294 | 272 |
| `src/commands/` | 59 | 59 |
| `src/package-publication/` | 667 | 498 |
| `src/publish-repository/` | 406 | 376 |
| `src/utils/` | 689 | 689 |
| `src/workspace-publication/` | 1,337 | 978 |
| **`src/` total** | **3,452** | **2,872** |
| **`tests/` total** | **7,719** | **7,307** |

The source reduction is 580 lines (17%) and the test reduction 412 lines. The spike was incomplete: `pnpm build` and `pnpm type-check` passed, but a test run against an earlier build reported 98 failures. Many tested removed closure behavior; the rest needed adapted fixtures, so finishing the spike would change the counts.

- **Runtime dependencies:** all nine in `package.json` were still imported in the spike, so none could be removed.
- **Detection stays:** refusing internal dependencies still needs workspace discovery and every package-manager-aware rule in [Workspace dependency resolution](./workspace-dependency-resolution.md#which-entries-are-internal): plain ranges, `file:` and `link:` paths, `workspace:` aliases, catalogs, and peers. That detection is where [#106](https://github.com/privatenumber/git-publish/issues/106) and [#110](https://github.com/privatenumber/git-publish/issues/110) come from, so removing closures would not fix them.

## What users would lose

- Selecting several packages, and publishing all public members from the workspace root ([Selecting packages](../../docs/monorepos.md#selecting-packages)).
- Publishing a package that depends on other workspace packages, with commit-pinned runtime and peer closures ([What gets published](../../docs/monorepos.md#what-gets-published)).
- Commit-pinned install sets ([Installing](../../docs/monorepos.md#installing)). Plain versions are not a fallback: they don't identify the published commit and usually resolve from the registry. In the experiment, pnpm, Yarn, and Bun failed with a registry 404 for an unpublished package; for a published package they can install a different build ([monorepo install sets](./monorepo-install-sets.md#why-the-set-is-installed-at-the-root)).

## Revisit when

- A package manager's own detection of workspace links can be queried reliably, so the detection could also go ([read-install experiment](./read-install-experiment.md) records why it can't today), or
- Closure publication is shown to be unused, so the lost features above cost nothing.
