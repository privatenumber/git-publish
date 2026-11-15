# Cost of workspace closure publication

**Decision.** Keep publishing workspace closures. Removing them would drop documented monorepo features while saving about 17% of `src/`, and the hardest code, detecting which dependencies are internal, would have to stay to refuse unsupported packages. Decided 2026-11-15 from a measurement spike against commit `56fbac1`.

## What closure publication is

When a selected workspace package depends on other workspace packages, git-publish publishes that whole closure: each package on its own branch, internal dependencies rewritten to commit-pinned Git URLs, all branches in one atomic push, and an install command per package ([monorepo install sets](./monorepo-install-sets.md)). The spike asked how much code remains if git-publish publishes exactly one package per run and refuses packages with internal runtime dependencies or internal peers.

## Method

A throwaway branch kept internal-dependency detection, added the refusal error, rejected selecting more than one package, and deleted the code that became unreachable: closure traversal, install sets and their output, multi-branch atomic push, dependency rewriting and pinning, peer-range validation, and packed-manifest edge validation. Line counts use `wc -l` on regular files, including blank lines and comments.

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

The source reduction is 580 lines (17%) and the test reduction 412 lines. The spike was incomplete: it built and type-checked, but an earlier build had 98 failing tests, some covering behavior that must stay with adapted fixtures. Finishing it would change the counts somewhat, not the conclusion.

- **Runtime dependencies:** all nine were still imported. None could be removed.
- **Detection stays:** refusing internal dependencies still needs workspace discovery and package-manager-aware detection of plain ranges (pnpm `link-workspace-packages`, Yarn transparent workspaces), `file:` and `link:` paths, `workspace:` aliases, catalogs, and peer ranges. That detection is where [#106](https://github.com/privatenumber/git-publish/issues/106) and [#110](https://github.com/privatenumber/git-publish/issues/110) come from, so removing closures would not fix them.

## What users would lose

- Selecting several packages, and publishing all public members from the workspace root ([Selecting packages](../../docs/monorepos.md#selecting-packages)).
- Publishing a package that depends on other workspace packages, with commit-pinned runtime and peer closures ([What gets published](../../docs/monorepos.md#what-gets-published)).
- Commit-pinned install sets ([Installing](../../docs/monorepos.md#installing)). Plain versions are not a fallback: pnpm, Yarn, and Bun look them up in the registry and fail ([monorepo install sets](./monorepo-install-sets.md#why-the-set-is-installed-at-the-root)).

## Revisit when

- A package manager's own detection of workspace links can be queried reliably, so the detection could also go ([read-install experiment](./read-install-experiment.md) records why it can't today), or
- Closure publication is shown to be unused, so the lost features above cost nothing.
