# Monorepo install sets

**Decision.** A workspace publication puts each package on its own branch, rewrites internal runtime dependencies in the packed manifests to commit-pinned Git URLs, and updates all branches in one `git push --atomic`. After the push, git-publish prints one install command per selected package that installs its whole set (the package, its internal runtime closure, and internal peer targets) as root dependencies. Every specifier in a multi-package set is commit-pinned and byte-identical to the pins inside the packed manifests.

Verified 2026-11-07 against npm 11.21.2 and 12.2.2, pnpm 10.34.9, 11.28.11, and 12.18.0, Yarn 1.22.22 and 4.18.1, and Bun 1.4.4.

## Packing and the publication graph

The publication graph is planned from source manifests and reconciled after packing. Only surviving runtime and peer edges determine the packages pushed and the install sets. A packed package name must match the planned name. A pack hook may remove dependency keys but cannot add keys or change unplanned values, except package-manager rewrites of `workspace:` and `catalog:` specifications. Removing an optional dependency while retaining the same key in dependencies is rejected because it changes precedence.

Packing can change dependencies: pnpm exposes [`beforePacking`](https://pnpm.io/pnpmfile), and Yarn exposes [`beforeWorkspacePacking`](https://yarnpkg.com/api/plugin-pack/interface/Hooks). pnpm can also normalize workspace specifications while creating the [exportable manifest](https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/releasing/exportable-manifest/src/index.ts#L252-L287), so the check allows package-manager rewrites for planned edges and `workspace:` or `catalog:` specifications. This rule also rejects hooks that add external dependencies, which develop accepted. Supporting additions safely would require resolving every alias form; revisit this if users need hooks that add dependencies. The plan remains fixed before packing: every planned package is packed and validated, even if a later pack hook makes it unreachable. Plan-time checks, including multiple push URLs and branch-template collisions, use the planned closure. The removal and rejection cases are covered by [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts).

## Why the set is installed at the root

Current package managers block Git dependencies that are declared by another Git dependency unless the consumer opts in:

| Package manager | Default for a Git dependency of a Git dependency | Source |
| --- | --- | --- |
| npm 12 | Blocked. `allow-git=root` allows only Git dependencies in the consumer's own `package.json` | [npm v12.0.0 release notes](https://github.com/npm/cli/releases/tag/v12.0.0): "allow-git and allow-remote now default to "none"; set them to "all" (or "root") to install git or user-supplied tarball-URL dependencies." |
| pnpm 11, 12 | Blocked by `blockExoticSubdeps`, which defaults to `true`; there is no per-repository allowlist | [`assertExoticSubdepAllowed` at v11.28.10](https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/installing/deps-resolver/src/resolveDependency.ts#L150-L165); [setting docs](https://pnpm.io/settings/dependency-resolution#blockexoticsubdeps) (accessed 2026-11-07) |
| Yarn 4 | Every Git repository is blocked, including direct ones, until it matches `approvedGitRepositories` (default `[]`) | [plugin-git at @yarnpkg/cli/4.18.1](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.18.1/packages/plugin-git/sources/index.ts#L36-L41) |
| npm 11, pnpm 10, Yarn 1, Bun | Allowed | Observed |

Observed with a fixture where branch `npm/app` depends on `@lab/core` through a commit-pinned Git URL to branch `npm/core`, served by a local `git daemon`:

```text
npm 12.2.2 --allow-git=root, installing app only:
npm error Fetching non-root packages of type "git" have been disabled
npm error Refusing to fetch "@lab/core@git://...#<core-sha>"

pnpm 11.28.11, installing app and core together as root dependencies:
ERR_PNPM_EXOTIC_SUBDEP  Exotic dependency "@lab/core" (resolved via git-repository)
is not allowed in subdependencies when blockExoticSubdeps is enabled
```

Installing app and core together as root dependencies, with core's specifier identical to the pin inside app's manifest, changes the result:

| Install shape | One instance of each internal package | Consumer settings beyond any Git install |
| --- | --- | --- |
| **Whole set as root dependencies** (chosen) | yes, in every tested manager | only pnpm 11/12 `blockExoticSubdeps: false` |
| Selected package only | yes | npm 12 `allow-git=all`, pnpm 11/12 `blockExoticSubdeps: false` |
| Root `overrides` / `resolutions` | yes | npm 12 `allow-git=all`, pnpm 11/12 `blockExoticSubdeps: false`, plus config edits |
| Dependents declare plain versions instead of Git pins | — | fails in pnpm, Yarn, and Bun: `@lab/core@npm:1.0.0: Package not found` (registry 404) |

"One instance" was checked at runtime: app and the consumer import core and compare an exported object by identity. The pnpm gate fires for the subdependency edge even when the identical URL is also a root dependency, so pnpm 11/12 consumers always need `blockExoticSubdeps: false` for a multi-package set.

Root specifiers are commit-pinned because a branch reference at the root would not match the commit pin inside a dependent's manifest. Each publication therefore prints an immutable set; upgrading means running the newly printed command. A package with no internal dependencies keeps the moving branch reference (`owner/repo#npm/main`), because a locked install never moves to a new branch commit on its own (`npm update`, `pnpm update`, and `bun update` move it; Yarn 4 needs `yarn up -R`).

Project behavior: [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts) ("reports separate install sets for shared runtime and peer packages", "keeps optional-only packages out of root install arguments"), [`tests/specs/publish-graph.ts`](../../tests/specs/publish-graph.ts) ("installs the required closure of an optional peer").

## Rejected alternatives

Each was tested with the same package managers on local transports (`file://`, `git daemon`, and a local HTTP server).

- **Bundle internal packages into the artifact** (committed `node_modules/<dep>` plus `bundleDependencies`). Only pnpm 10/11/12 used the bundled copy. npm reported success but dropped the bundle when installing from Git while keeping it when installing the tarball of the same commit ([npm/cli#10250](https://github.com/npm/cli/issues/10250) has the reproducer); Yarn 1, Yarn 4, and Bun looked the bundled package up in the registry. Lifting the bundled package's external dependencies into the dependent also bound it to a range it did not declare (`ms@^1.0.0` instead of `^2.1.3`) without an error.
- **One branch with packages in subdirectories.** Each manager needs its own spec: npm `#<sha>::path:packages/app`, pnpm `#<sha>&path:/packages/app`, Yarn 4 `#commit=<sha>&workspace=<name>` (which also requires a root workspace manifest on the branch). Yarn 1 and Bun had no working selector. A published manifest holds one spec, so no artifact serves every consumer.
- **Tarball URLs.** Installed everywhere once allowed, but hit the same gates: npm 12 `EALLOWREMOTE` for a non-root URL and pnpm `ERR_PNPM_EXOTIC_SUBDEP`. It also needs hosting outside Git.
- **Registry snapshots or preview services.** They require a registry or a third-party service. git-publish's purpose is to publish using only the Git host the user already has.

Revisit the bundling option if npm installs bundled dependencies from Git dependencies and Yarn and Bun use bundled copies; revisit subdirectories if one Git subdirectory spec becomes portable across managers.

## Scale

Internal closures in real monorepos are usually small but have a long tail. A survey of 40 public monorepos (1,525 non-private packages, name-matched estimates, scanned 2026-11-07) found a per-package internal runtime closure of p50 = 1, p90 = 13, p99 = 94, and max = 160 (`@pnpm/exec.commands`).

- **Publishing:** about 0.7 s per package on a local remote (Changesets: 14 packages in 9.1 s; Lexical: 24 packages in 18.4 s), dominated by `pack`. Remote round trips are constant per run because branch lookups and fetches are batched into one `ls-remote` and one `fetch` ([test "batches remote branch lookups and fetches for a workspace closure"](../../tests/specs/workspace-publication.ts)).
- **Installing:** a synthetic 100-package set (depth 8, 256 internal edges) installed on npm 11 and 12, pnpm 10 and 12, Yarn 4, and Bun; the slowest root install was 45 s (npm 12, local daemon, four concurrent Git clients). Yarn 1 timed out after 600 s at 100 packages and took 197 s at 20, so Yarn 1 is best effort.
- **Storage:** Git stores identical file contents once, so republishing unchanged packages is cheap; unchanged packages also reuse their existing commit.

These timings are local measurements and do not predict GitHub latency.
