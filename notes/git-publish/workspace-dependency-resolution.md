# Workspace dependency resolution

**Decision.** git-publish builds the publication graph from source manifests before packing, because packing erases `workspace:` intent. It classifies internal edges using the rules below, which approximate package-manager linking but do not cover every linked dependency. In particular, it omits an `npm:` alias that Yarn or Bun links to a workspace in the [read-install experiment](./read-install-experiment.md#results). Verified 2026-11-14.

## Which entries are internal

| Entry | Internal when | Test |
| --- | --- | --- |
| `workspace:*`, `workspace:^`, `workspace:~`, aliases such as `workspace:core@*` | always; an explicit range (`workspace:^2.0.0`, also inside an alias) must be satisfied by the target's version | "rejects mismatched explicit workspace ranges before packing", "rejects an aliased workspace range that does not match its target" |
| plain semver range (`^1.0.0`) | the target's version satisfies it, and the package manager links plain ranges: npm and Bun always; Yarn unless transparent workspaces are disabled; pnpm only when `linkWorkspacePackages` is enabled | "links pnpm plain ranges when workspace linking is enabled", "reads Yarn transparent workspace configuration at the workspace root" |
| `file:<path>`, `link:<path>` | the path resolves to a workspace package directory | "publishes and pins an npm sibling file dependency" |
| `catalog:` | the effective catalog entry resolves to an internal dependency by the rules above | "publishes pnpm included catalog dependency", "publishes a Yarn catalog workspace dependency" |

Tests are in [`tests/specs/publish-graph.ts`](../../tests/specs/publish-graph.ts) and [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts).

The plain-range rule matters because npm has no `workspace:` protocol: an npm workspace links siblings only through ranges or `file:` paths, so a `workspace:`-only rule would publish no closure for npm monorepos. In a survey of 40 public monorepos, 11% of internal edges were plain ranges. pnpm does not link plain ranges by default, so treating them as internal there would replace a registry dependency with a sibling commit.

Catalogs are resolved before graph construction using effective package-manager configuration, so included pnpm configuration and Yarn configuration inherited from the environment or home directory are not missed. Yarn's unnamed `catalog:` and named `catalog:default` are distinct ([Yarn 4.18.1 source](https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.18.1/packages/plugin-catalog/sources/utils.ts#L21-L36)); the "distinguishes Yarn unnamed and named default catalogs" test publishes both cases. Missing catalog entries for workspace names stop publication before packing rather than silently omitting an edge.

The isolated pack checkout does not inherit package-manager configuration located above the Git repository, such as an ancestor `.yarnrc.yml`. A catalog that depends on that configuration can therefore resolve during planning but fail during packing, before publication.

Explicit `workspace:` ranges are checked by git-publish because the package manager does not always check them. pnpm 10.34.9 installs a workspace where `app` declares `core: "workspace:^2.0.0"` and the local `core` is `1.0.0`; pnpm 12.18.0 rejects it (`No matching version found for core@workspace:^2.0.0 inside` the workspace).

Prerelease matching follows npm: a prerelease version satisfies only `*` and the empty range, not `x` or `^1.0.0`.

## Peers

Internal peer targets are published and included in the install set, but peer ranges are not rewritten: a root Git copy satisfies the packed semver peer range in npm, pnpm, Yarn, and Bun. With the registry pointed at a server that returns 404 for everything, no manager requested the peer from the registry. Because managers disagree on an unsatisfied peer (npm fails with `ERESOLVE`, pnpm and Yarn warn, Bun installs silently), git-publish checks every packed peer range against the target's packed version before pushing ("rejects a packed internal peer range mismatch before pushing").

Plain-range peers are internal for every package manager, including pnpm and Yarn with transparent workspaces disabled: those settings decide how runtime dependencies are linked, not which peer the consumer must provide. `file:` and `link:` peers are rejected because consumers cannot resolve them.

pnpm 10.29.3 packs an installed aliased peer `alias: "workspace:core@*"` as `"1.0.0core@*"`; pnpm 11.28.10 and 12.18.0 pack `"npm:core@*"`. git-publish accepts the `npm:` form and rejects the malformed one before pushing ("validates packed peer ranges, including pnpm aliases").

## Optional dependencies

A package reachable only through `optionalDependencies` or an optional peer (`peerDependenciesMeta`) is published but is not a required root install argument: a platform-restricted optional package would otherwise make the printed command fail. When a key appears in both `dependencies` and `optionalDependencies`, the optional entry wins, as in npm. Peers of optional dependencies are not installed by npm, so they get their own printed install line.

## Private packages

`private: true` is rejected without `--force` only for the workspace root and for standalone packages. [Issue #2](https://github.com/privatenumber/git-publish/issues/2) introduced the guard "for catching publishing the root of a monorepo". Private workspace members are the main audience of Git-branch publishing: they are not on a registry, which is what `private: true` marks in monorepos. The pre-push plan marks them `(private)`.

## Pack hooks and published manifests

Lifecycle hooks may remove an internal dependency from the packed manifest; the removal is kept. Changing an internal dependency to an alias of another package or to a URL, Git, or `file:` value that differs from the source manifest fails before pushing. Adding internal dependencies during packing is not supported. After rewriting, a leftover `workspace:` value in any dependency field fails before pushing.

Packed dependency ranges are checked against the dependency's packed version even if unchanged, because a prepack hook can change that version. For unchanged `workspace:^` and `workspace:~` entries, the range uses the target source version; `workspace:*` remains `*`. An unplanned path outside the package is rejected even if it was already present in the source manifest. The check uses `npm-package-arg` to classify and resolve local files and directories, with separate handling for workspace paths and Yarn locators. pnpm's `link:` is classified as the equivalent `file:` path, because `npm-package-arg` rejects that protocol. A packed name different from the planned name is also rejected before pushing. See the path table and shorthand regression in [`tests/specs/package-publication.ts`](../../tests/specs/package-publication.ts) and [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts). Yarn uses `0.0.0` for a versionless workspace target, so the check uses that fallback for Yarn only. With a versionless `core` workspace and an `app` depending on `core` via `workspace:*`, `workspace:^`, or `workspace:~`, `yarn install` followed by `yarn pack --out out.tgz` with Yarn 4.18.1 produced `0.0.0`, `^0.0.0`, and `~0.0.0` respectively in the packed app manifest. With the same inputs, `pnpm install` and `pnpm pack --pack-destination .` on pnpm 12.18.0 failed with `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`; `bun install` and `bun pm pack --destination .` on Bun 1.4.4 failed with `Failed to resolve workspace version`. Verified 2026-11-14. The real-publication tests cover all three Yarn forms and the incompatible packed-version rejection.

### Rejected alternative

A single consolidated packed-manifest rule was tried on `fix/packed-manifest-invariant` and rejected after two review rounds found regressions:

- Non-string planned peer values were accepted.
- Peer ranges were checked against the full plan instead of the effective reachable plan.
- Yarn registry aliases whose target name matched an incompatible workspace package were rejected.

A packed `catalog:` resolving to an alias also bypassed the guard; that was pre-existing. Revisit consolidation if the planner exposes a single packed-manifest classification result covering catalogs and aliases.

The published manifest drops `scripts.prepare`, `scripts.prepack`, `scripts.postpack`, the `workspaces` field, and `devDependencies`. npm reruns preparation for a Git dependency that has `prepare`, `build`, install hooks, or `workspaces` ([npm package.json docs, "git URLs as dependencies"](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#git-urls-as-dependencies)), and Yarn 4 packs Git dependencies with `yarn pack`, which runs `postpack`. Dropping `devDependencies` keeps that preparation from fetching unpublished private siblings. `scripts.build` is removed too, unless an install hook remains that may call it.

Dependency fields are written in the source manifest's key order, because `pnpm pack` emitted `dependencies` in two different orders across five packs of the same unchanged package (pnpm 11.13.1), which made unchanged packages republish and cascade new pins to their dependents.
