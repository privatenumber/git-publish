# Monorepo install sets

**Decision (2026-11-22).** A workspace publication puts each package on its own branch and pushes the branches atomically. The command lists only the selected package and required internal peers; runtime dependencies install transitively. Making the whole closure direct helped npm but did not bypass pnpm's Git dependency gate, so the command keeps the smaller set and reports the required settings.

[Branches as a prerelease channel](./branch-channel.md) supersedes the earlier commit-pin and qualified-selector designs. Manifests and commands use the same bare branch Git specifiers. A single package with no internal edges can still use GitHub shorthand, except with Yarn over SSH: Yarn expands shorthand to HTTPS before checking `approvedGitRepositories`.

## Supported Yarn versions

**Yarn publishing policy.** Yarn 1 is rejected before packing each package, so the check uses the Yarn version resolved in that package's pack directory. Dry runs do not perform this check. Yarn 2 and later remain accepted, with Yarn 4 recommended. Yarn 1.0.0 was released on 2017-09-05 and 1.22.22 on 2024-03-09 ([release tags](https://github.com/yarnpkg/yarn/releases)); [Yarn 2's January 2020 announcement](https://yarnpkg.com/blog/release/2.0) put Yarn 1 in maintenance mode. No release packed with Yarn 1: v2.2.1 and earlier ran npm scripts and npm-packlist without invoking Yarn, and v2.3.0 through v2.5.0 passed `--pack-destination`, which Yarn 1 ignores, so publishing failed ([#81](https://github.com/privatenumber/git-publish/issues/81)). Rejecting it is therefore not a breaking change. No revisit is expected.

Yarn 2 and 3 were released on [2020-01-24](https://yarnpkg.com/blog/release/2.0) and [2021-07-26](https://yarnpkg.com/blog/release/3.0), respectively. Yarn's maintainers [say they have no formal LTS and do not usually backport fixes](https://github.com/yarnpkg/berry/discussions/2814), although critical fixes may be considered. Yarn 3 received [3.8.7 on 2024-12-04](https://github.com/yarnpkg/berry/releases/tag/%40yarnpkg%2Fcli%2F3.8.7), after Yarn 4. This is not evidence of an explicit end-of-support date for either major. Their acceptance remains unchanged; current tests exercise Yarn 4, not 2 or 3.

## Packing and the publication graph

The publication graph is planned from source manifests. The planner resolves `catalog:` entries for pnpm, Yarn, and Bun before deciding whether they point at workspace packages; see [workspace dependency resolution](./workspace-dependency-resolution.md#which-entries-are-internal). After packing, runtime and peer edges removed by pack hooks are dropped from the pushed closure and install sets. pnpm exposes [`beforePacking`](https://pnpm.io/pnpmfile), and Yarn exposes [`beforeWorkspacePacking`](https://yarnpkg.com/api/plugin-pack/interface/Hooks).

Known limits:

- Detection of added or redirected internal dependencies is incomplete. Tracked in [#108](https://github.com/privatenumber/git-publish/issues/108). Validation rejects a changed packed name, an unplanned local path outside the package, including an entry already present in the source manifest, unresolved `workspace:` specifications, and planned runtime edges with incompatible packed ranges, including unchanged ranges. The local-path check skips a `dependencies` entry shadowed by an `optionalDependencies` entry. It also rejects moving a planned key to a field that did not previously declare it, and removing a planned optional override while its dependency remains. Removing an unplanned external optional override does not trigger that rejection. Complete detection would require resolving every alias, catalog, and protocol form; see the [rejected consolidated rule](./workspace-dependency-resolution.md#rejected-alternative).
- The conservative local-path check also rejects some valid manager-specific spellings, including `file:~/x` in Yarn and `file:/./x` in npm. Use `file:./x` for an in-package path instead. The check reads spellings, not each manager's path semantics, so some outside paths still pass: an unprefixed path that doesn't start with `./`, `../`, `/`, or `~/` (npm reads `vendor/../../x` as a directory), an unprefixed Windows drive path, and Yarn's percent-encoded selectors (`file:%2e%2e%2fx` decodes to `../x`). Four review rounds on manager-specific path resolution kept finding new divergences between npm and Yarn (`file:~/x`, `file:/./x`, `::locator=`, `portal:`), so the check stays syntactic.
- A peer included only because a runtime edge selected its target can still cause a peer-range mismatch error after the runtime edge is removed. This fails closed and is rare.
- The plan is fixed before packing. Every planned package is packed and validated, even if a later pack hook makes it unreachable. Branch-template collision checks use the planned closure.

Removal behavior is covered by [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts).

## Why consumers need Git dependency settings

Current package managers block Git dependencies that are declared by another Git dependency unless the consumer opts in:

| Package manager | Default for a Git dependency of a Git dependency | Source |
| --- | --- | --- |
| npm 12 | Blocked unless `allow-git=all`. `allow-git=root` allows only direct Git dependencies. | [npm v12.0.0 release notes](https://github.com/npm/cli/releases/tag/v12.0.0): "allow-git and allow-remote now default to "none"; set them to "all" (or "root") to install git or user-supplied tarball-URL dependencies." |
| pnpm 11, 12 | Blocked by `blockExoticSubdeps`, which defaults to `true`; there is no per-repository allowlist | [`assertExoticSubdepAllowed` at v11.28.10](https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/installing/deps-resolver/src/resolveDependency.ts#L150-L165); [setting docs](https://pnpm.io/settings/dependency-resolution#blockexoticsubdeps) (accessed 2026-11-07) |
| Yarn 4 | Every Git repository is blocked, including direct ones, until it matches `approvedGitRepositories` (default `[]`) | [plugin-git at @yarnpkg/cli/4.18.1](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.18.1/packages/plugin-git/sources/index.ts#L36-L41) |
| npm 11, pnpm 10, Yarn 1, Bun | Allowed | Observed |

### Selected-package install experiment

Verified 2026-11-22 on macOS with Node.js 26.13.0 and Git 2.54.0. A bare Git repository has branch `npm/app` with `dependencies: { "@lab/core": "<url>#<core-sha>" }`. The `npm/core` branch has moved to another commit with the same package version. The original core exports `{ marker: 'pinned' }`; the new tip exports `{ marker: 'moved' }`. The consumer installs only app. `$url` is a `git+file://` URL for npm, pnpm, and Bun. Yarn uses HTTPS mapped to the bare repo via Git `insteadOf`, with the HTTPS URL in `approvedGitRepositories` and `nodeLinker: node-modules`. The bare repository has a valid `HEAD`.

| Package manager | Command | Opt-out result | Observed without the opt-out |
| --- | --- | --- | --- |
| npm 12.2.2 | `npm i --allow-git=all "$url#npm/app"` | One core copy at the SHA in app's manifest | Default: `EALLOWGIT`, `Fetching packages of type "git" have been disabled`. With `--allow-git=root`: `EALLOWGIT`, `Fetching non-root packages of type "git" have been disabled`. |
| pnpm 12.21.0 | `pnpm add --config.block-exotic-subdeps=false "$url#npm/app"` | One core copy at the SHA in app's manifest | `ERR_PNPM_EXOTIC_SUBDEP`, `blockExoticSubdeps is enabled`. |
| Yarn 4.18.1 | `yarn add "@lab/app@$url#npm/app"` | One core copy at the SHA in app's manifest | No runtime opt-out required. Repository approval still applies. |
| Bun 1.4.4 | `bun add "$url#npm/app"` | One core copy at the SHA in app's manifest | No opt-out required. |

Each successful lockfile records `<core-sha>`. `find node_modules -type f -path '*/@lab/core/package.json'` finds one copy, and `require('@lab/app').core.marker` returns `'pinned'`.

A second app branch adds `peerDependencies: { "@lab/peer": "^1.0.0" }` and loads that package at runtime. App-only installs tried the registry in npm, pnpm, and Bun. Yarn completed with `YN0002` ("doesn't provide @lab/peer"), then app failed with `MODULE_NOT_FOUND`. Adding `"$url#npm/peer"` (Yarn: `"@lab/peer@$url#npm/peer"`) to the command let app load the peer on all four managers; each still installed one pinned core.

### Historical runtime and peer overlap

When `app` declared `core` as both a runtime SHA pin and a peer, adding the same SHA pin at the root loaded one copy at the pinned commit in all four managers. Adding the moved branch at the root instead loaded one copy at the moved commit in npm and pnpm. Yarn loaded the moved commit from both importers but recorded both commits in the lockfile. Bun loaded two copies. This explains why the old design matched the SHA for overlapping arguments. The [branch-channel design](./branch-channel.md) now uses the same moving branch specifier at both sites.

### Historical rationale for installing the whole set

The historical experiments were verified 2026-11-07 against npm 11.21.2 and 12.2.2, pnpm 10.34.9, 11.28.11, and 12.18.0, Yarn 1.22.22 and 4.18.1, and Bun 1.4.4. Yarn 1 results are historical consumer measurements, not a supported publishing configuration.

The earlier fixture used a local `git daemon` with `npm/app` depending on `@lab/core` through a commit pin:

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
| **Whole set as root dependencies** (historical choice) | yes, in every tested manager | only pnpm 11/12 `blockExoticSubdeps: false` |
| Selected package only | yes | npm 12 `allow-git=all`, pnpm 11/12 `blockExoticSubdeps: false` |
| Root `overrides` / `resolutions` | yes | npm 12 `allow-git=all`, pnpm 11/12 `blockExoticSubdeps: false`, plus config edits |
| Dependents declare plain versions instead of Git pins | — | fails in pnpm, Yarn, and Bun: `@lab/core@npm:1.0.0: Package not found` (registry 404) |

"One instance" was checked at runtime: app and the consumer import core and compare an exported object by identity. The pnpm gate fires for the subdependency edge even when the identical URL is also a root dependency, so pnpm 11/12 consumers need `blockExoticSubdeps: false` when the install includes an internal Git runtime edge.

Project behavior: both the main command and the optional-peer follow-up add required peers only through required edges from their respective roots. The follow-up may name a peer of an optional dependency reached by the main command, but does not also promote peers reached only through optional edges of that follow-up. npm rejects a direct Linux-only argument on macOS with `EBADPLATFORM`; it can skip the same package when it is optional. Policy guidance uses a broader traversal that checks internal and external Git URLs, HTTP tarball URLs, and required external peers in the packed manifests. See [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts) ("keeps optional-only packages out of root install arguments"), [`tests/specs/publish-graph.ts`](../../tests/specs/publish-graph.ts) ("installs the required closure of an optional peer"), and the [table-driven npm and pnpm install-policy cases](../../tests/specs/package-managers.ts#L21-L62).

## Rejected alternatives

Each was tested with the same package managers on local transports (`file://`, `git daemon`, and a local HTTP server).

- **Bundle internal packages into the artifact** (committed `node_modules/<dep>` plus `bundleDependencies`). Only pnpm 10/11/12 used the bundled copy. npm reported success but dropped the bundle when installing from Git while keeping it when installing the tarball of the same commit ([npm/cli#10250](https://github.com/npm/cli/issues/10250) has the reproducer); Yarn 1, Yarn 4, and Bun looked the bundled package up in the registry. Lifting the bundled package's external dependencies into the dependent also bound it to a range it did not declare (`ms@^1.0.0` instead of `^2.1.3`) without an error.
- **One branch with packages in subdirectories.** Each manager needs its own spec: npm `#<sha>::path:packages/app`, pnpm `#<sha>&path:/packages/app`, Yarn 4 `#commit=<sha>&workspace=<name>` (which also requires a root workspace manifest on the branch). Yarn 1 and Bun had no working selector. A published manifest holds one spec, so no artifact serves every consumer.
- **Tarball URLs.** Installed everywhere once allowed, but hit the same gates: npm 12 `EALLOWREMOTE` for a non-root URL and pnpm `ERR_PNPM_EXOTIC_SUBDEP`. It also needs hosting outside Git.
- **Registry snapshots or preview services.** They require a registry or a third-party service. git-publish's purpose is to publish using only the Git host the user already has.

Revisit the bundling option if npm installs bundled dependencies from Git dependencies and Yarn and Bun use bundled copies; revisit subdirectories if one Git subdirectory spec becomes portable across managers.

## Scale

Internal closures in real monorepos are usually small but have a long tail. A survey of 40 public monorepos (1,525 non-private packages, name-matched estimates, scanned 2026-11-07) found a per-package internal runtime closure of p50 = 1, p90 = 13, p99 = 94, and max = 160 (`@pnpm/exec.commands`).

- **Publishing:** about 0.7 s per package on a local remote (Changesets: 14 packages in 9.1 s; Lexical: 24 packages in 18.4 s), dominated by `pack`. The number of Git lookups and fetches per run is bounded independently of package count. History and tag lookups share one `ls-remote` when they use the same target; an explicit `pushurl` requires a separate tag lookup when loading history. One `fetch` loads all existing publish tips. Fresh publications and empty history need no fetch. See [the test "batches history and tag lookups only on a shared remote without pushurl"](../../tests/specs/workspace-publication.ts).
- **Installing:** a synthetic 100-package set (depth 8, 256 internal edges) installed on npm 11 and 12, pnpm 10 and 12, Yarn 4, and Bun; the slowest root install was 45 s (npm 12, local daemon, four concurrent Git clients). In the historical consumer experiment, Yarn 1 timed out after 600 s at 100 packages and took 197 s at 20.
- **Storage:** Git stores identical file contents once, so republishing unchanged packages is cheap; unchanged packages also reuse their existing commit.

These timings are local measurements and do not predict GitHub latency.
