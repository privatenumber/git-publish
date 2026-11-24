# Branches as a prerelease channel

**Decision (Sun Nov 22 2026).** git-publish publishes a prerelease channel, in the same way that an npm dist-tag such as `beta` is a channel. Published manifests reference internal workspace dependencies by their moving publish branch, such as `git+ssh://git@github.com/o/r.git#npm/core`, and never by commit. Printed install commands use the same branch references. The consumer's lockfile pins commits. Before packing, git-publish checks the destination for refs that can conflict with a bare branch selector. The check can miss unusual ref spellings and cannot prevent someone from adding a conflicting ref later.

This replaces the commit-pinned design in [Monorepo install sets](./monorepo-install-sets.md), where each dependent's manifest pinned its internal dependencies to the commits published with it.

## Why

- **The channel model is the intended contract.** Installing `"b": "beta"` can pair a dependent with a newer `b` than the one it was tested with. The user chose the same risk for git-publish: a prerelease channel may deliver breaking changes, and the lockfile is what makes an install reproducible.
- **A new dependency commit no longer changes the dependent's manifest.** With commit pins, a new publication commit for `core` changes every manifest that pins it. A branch reference stays the same, so dependents can reuse their commits if their packed files are unchanged. A build hook that embeds dependency output can still change those files.
- **Packing no longer needs dependency order for commit content.** [Publication performance](./publication-performance.md) records that commit preparation used to need the commits of its dependencies. A branch reference is known before anything is packed. Runtime compatibility checks still use the target's packed version during preparation; peer ranges are checked after packing.
- **One specifier form everywhere.** The root argument and the nested dependency use byte-identical specifiers, so there is no special case for a package that is both a peer and a runtime dependency.

## What this gives up

- **A publication is no longer a snapshot.** A fresh install with neither the previous lockfile nor `node_modules` gets the current branch tips, not the commits published together. git-publish validates dependency and peer ranges against the packages published in the same run. A dependency published alone later can be incompatible, and a package manager can report a peer range mismatch.
- **The atomic push is not an atomic install.** git-publish updates multiple branches in one `git push --atomic`, but a package manager can resolve one branch before the push and another after it.
- **Updates differ by package manager.** In the experiment below, `npm update app` moved `app` but not `core`, while pnpm and Bun moved both. To follow the whole channel, update every channel package by install key. A fresh install without the previous lockfile and `node_modules` can also update unrelated dependencies. Deleting only the lockfile can leave npm using the old commits in `node_modules`.

## Selector choice

A published manifest is read by whichever package manager the consumer uses, so its selector must work in all of them. Of the selectors tested, only the bare branch name did.

Nested dependency `core` declared by `app` with each selector. Each cell is "no same-named tag → a tag named `npm/core` at a different commit":

| Manager | `#npm/core` | `#refs/heads/npm/core` | `#head=npm/core` |
| --- | --- | --- | --- |
| npm 12.2.2 | Branch → branch content, but the lockfile records the tag commit | Branch → branch | Rejected |
| pnpm 12.21.0 | Branch → tag | Branch → branch | Rejected |
| Yarn 4.18.1 | Branch → tag | Rejected | Branch → branch |
| Bun 1.4.4 | Branch → tag | Branch → branch | Rejected |

No tested selector is both accepted by all four managers and unambiguous. The bare name is accepted by all four, so git-publish uses it and checks for conflicting refs before packing. A dry run reads local remote config without contacting the remote and does not perform this check. The check cannot stop a conflicting ref created after the lookup. In the npm tag collision fixture, `npm ci` installed branch content that differed from the commit in the lockfile.

The conflict check lists refs on the push URL, even when branch history uses a different URL. For a remote without an explicit `pushurl`, an applicable [`pushInsteadOf` rule](./remote-urls.md#decision-unsupported-remote-setups) can send the push to a different repository from the one the check reads.

### Rendered branch validation

These fixtures installed `app`, whose manifest used the selector below for `core`. `Branch` means the installed content and the lockfile both matched the intended branch tip. The Git repositories and package-manager versions match [the experiment below](#experiment). The qualified-name cases included a competing ref.

| Bare selector | npm | pnpm | Yarn | Bun |
| --- | --- | --- | --- | --- |
| `npm/feature/a-@scope/core_1.2`, `npm/a@b` | Branch | Branch | Branch | Branch |
| `npm/a&b` | Branch | Error | Branch | Branch |
| `npm/a#b` | Branch | Branch | Branch | Error |
| `npm/a+b`, `npm/a=b`, `npm/a'b`, `npm/a,b` | Branch | Branch | Branch | Branch |
| `npm/a%b` | Branch | Branch | Error | Branch |
| `npm/a%2Fb` | Branch | Other branch | Branch | Branch |
| `npm/aé` | Error | Branch | Branch | Branch |
| `refs/tags/core` | Tag | Tag | Branch | Tag |
| `tags/core` | Branch | Tag | Branch | Tag |
| `heads/core`, `refs/heads/core` | Branch | Other branch | Branch | Other branch |
| `HEAD` | Default branch | Default branch | Default branch | Default branch |
| `head`, `HeAd` | Branch | Branch | Branch | Default branch |
| `@` | Branch | Branch | Not tested | Default branch |
| `FETCH_HEAD` | Branch | Branch | Not tested | Cold cache: branch. Warm cache, no lockfile: default branch. |
| `ORIG_HEAD`, `MERGE_HEAD`, `AUTO_MERGE`, `ABC`, `_` | Not tested | Not tested | Not tested | Branch |
| `npm/@`, `@/npm`, `npm/@/core`, `npm/-main`, `a.b`, `a@b`, `ABC1`, `fetch_head`, `HEAD/foo` | Not tested | Not tested | Not tested | Branch |
| `-main`, `--all` | Not tested | Not tested | Not tested | Branch if manually pushed; Git rejects these as branch names |
| `a..b`, `npm/.a` | Not tested | Not tested | Not tested | Error; Git rejects the ref |
| 3 to 6 lowercase hex digits | Branch | Branch | Branch | Branch |
| 7, 8, 12, 32, or 39 lowercase hex digits | Branch | Error | Branch | Branch |
| 40 lowercase hex digits, no object with that ID | Error | Error | Error | Error |
| 40 uppercase hex digits, no object with that ID | Branch | Branch | Branch | Error |
| 63 or 64 lowercase hex digits | Error | Branch | Branch | Branch |
| 65 lowercase hex digits, or `npm/` followed by 40 lowercase hex digits | Branch | Branch | Branch | Branch |

In a separate fixture, Bun accepted a 40-hex branch named after an existing Git object, recorded the branch name instead of its resolved tip in the lockfile, then advanced the dependency on a cold frozen install. The all-hex errors above used names that were not object IDs.

To reproduce the warm-cache `FETCH_HEAD` result, run `bun install --cache-dir <shared-cache>` in two fresh consumer directories with no lockfiles. Both depend on `app` at `#npm/app`; `app` depends on `core` at `#FETCH_HEAD` in the same repository. Set the default branch to `main` and put different `core` content on each branch. The first install created no top-level `FETCH_HEAD` in the cache. The second fetched into that cache, wrote `FETCH_HEAD` with the remote default commit first, then installed and locked that commit instead of `refs/heads/FETCH_HEAD`.

Planning checks every rendered name, including in `--dry`. Allow ASCII letters, digits, and `. _ / @ -` so default branches for scoped packages still work. Do not allow `refs/`, `heads/`, `tags/`, or `remotes/` at the start (`remotes/` is another Git ref namespace). Reject bare `@`, `HEAD` in any case, top-level names made only of uppercase letters and underscores, and whole names of 7 to 64 hexadecimal digits, case-insensitively. [Git treats `@` as `HEAD`](https://github.com/git/git/blob/v2.54.0/Documentation/revisions.adoc?plain=1#L86-L87) and [looks at top-level ref files before branch names](https://github.com/git/git/blob/v2.54.0/Documentation/revisions.adoc?plain=1#L26-L47). pnpm starts interpreting hex as a commit at seven digits; npm's [Pacote hash matcher at v12.2.3](https://github.com/npm/cli/blob/v12.2.3/node_modules/pacote/lib/git.js#L13) covers 40 to 64, and Bun also interprets uppercase 40-hex names as commits. Git branch validation still applies. The allowlist deliberately omits punctuation outside common branch and package names even when a tested spelling worked.

### Remote refs that can conflict

For an accepted bare `#<b>`, the resolvers use these names:

| Resolver | Candidate names and order |
| --- | --- |
| [npm 12.2.2](https://github.com/npm/cli/blob/v12.2.2/node_modules/@npmcli/git/lib/lines-to-revs.js#L63-L134) | `refs/heads/<b>` and `refs/tags/<b>` are indexed by their short names. A ref under `refs/pull/` is indexed without `refs/` and without a trailing `/head`. When `b` is `pull/...`, `refs/<b>` contributes if it does not end in `/head`; `refs/<b>/head` contributes when `b` is `pull` or starts with `pull/`. The last matching alias wins. |
| [pnpm 12.21.0](https://github.com/pnpm/pnpm/blob/v12.21.0/pnpm/crates/resolving-git-resolver/src/resolve_ref.rs#L159-L177) | `<b>`, `refs/<b>`, `refs/tags/<b>^{}`, `refs/tags/<b>`, `refs/heads/<b>`, in that order. |
| [Yarn 4.18.1](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.18.1/packages/plugin-git/sources/gitUtils.ts#L170-L240) | A full commit hash (excluded by validation), then `refs/tags/<b>`, then `refs/heads/<b>`. |
| [Bun 1.4.4](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/install/git_runner.rs#L1069-L1103) via [Git revision lookup](https://github.com/git/git/blob/v2.54.0/Documentation/revisions.adoc?plain=1#L26-L47) | For refs present in the clone: `<b>`, `refs/<b>`, `refs/tags/<b>`, `refs/heads/<b>`, `refs/remotes/<b>`, `refs/remotes/<b>/HEAD`, in that order. |

The preflight excludes the intended branch `refs/heads/<b>` from conflicts. It also excludes top-level `<b>` because [Git's `ls-remote --refs`](https://github.com/git/git/blob/v2.54.0/Documentation/git-ls-remote.adoc#L37-L38) omits pseudorefs such as `HEAD`, and accepted selectors cannot name advertised refs directly. There is no separate lookup for `refs/tags/<b>^{}`: it is a peeled record for the same tag, and `--refs` still returns the tag itself. The remaining candidates are `refs/<b>`, `refs/tags/<b>`, `refs/remotes/<b>`, `refs/remotes/<b>/HEAD`, and npm's conditional `refs/<b>/head`. Check exact names after `ls-remote` because [Git's patterns also match at slash boundaries inside a ref](https://github.com/git/git/blob/v2.54.0/Documentation/git-ls-remote.adoc#L93-L102).

With no same-named tag, npm 12.2.2 installed `refs/pull/7/head` for `#pull/7`, and pnpm 12.21.0 installed `refs/notes/preview` for `#notes/preview`. Regression tests cover both collisions and verify that nested refs matching only the lookup pattern do not block `#pull/7`.

**Known limitation:** [npm 12.2.2 splits each advertised ref line on JavaScript whitespace](https://github.com/npm/cli/blob/v12.2.2/node_modules/@npmcli/git/lib/lines-to-revs.js#L82-L89). It can read a tag named `preview<U+00A0>old` (with a non-breaking space) as `preview` and select it over the branch, even though the exact-name preflight finds no conflict. The preflight catches accidental collisions. It does not protect against someone who can write refs on the destination: they can add a conflicting ref after the check or push the branch directly. Modeling each resolver's tokenizer would add complexity without stopping anyone who was not already able to change the result.

### Install policy for packed dependencies

**Decision.** Every npm command includes `--allow-git=all` and every pnpm command includes `--config.block-exotic-subdeps=false`. A consumer's other dependencies may also be git-publish packages, especially in monorepos, and the publisher cannot see them, so a manifest-based choice can produce a command that fails. Choosing `--allow-git=root` when every Git dependency was listed directly, and omitting the pnpm flag when the packed manifests had no Git or tarball dependency, was implemented and rejected for this reason. Revisit if npm or pnpm adds a per-repository allowlist.

Only npm's `--allow-remote=all` still depends on the packed manifests. Use the packed `dependencies` and `optionalDependencies`, plus required `peerDependencies` not marked optional in `peerDependenciesMeta` and not shadowed by a runtime or optional entry with the same key. [npm 12.2.2 has separate `allow-git` and `allow-remote` settings](https://github.com/npm/cli/blob/v12.2.2/workspaces/config/lib/definitions/definitions.js#L227-L268): the flag is added when `npm-package-arg@14.0.0` returns `remote`. npm's [tarball exemption requires a registry-mediated dependency](https://github.com/npm/cli/blob/v12.2.2/workspaces/arborist/lib/arborist/reify.js#L986-L1003). An explicit tarball URL is not exempt just because it uses the registry's origin. pnpm's `blockExoticSubdeps` blocks both Git and HTTP(S) runtime or optional subdependencies, not `file:` ([pnpm 12.21.0 setting](https://github.com/pnpm/pnpm/blob/v12.21.0/pnpm/docs/settings/dependency-resolution.md?plain=1#L479-L490), [allowed resolver sources](https://github.com/pnpm/pnpm/blob/v12.21.0/pnpm/crates/resolving-deps-resolver/src/resolve_dependency_tree/manifest.rs#L455-L470)). pnpm also accepts plain `ssh:` as Git ([Git resolver at 12.21.0](https://github.com/pnpm/pnpm/blob/v12.21.0/pnpm/crates/resolving-git-resolver/src/parse_bare_specifier.rs#L61-L77)).

In fresh consumers, a Git-installed `app` declared `core` as a required peer using either `git+file:///path/to/repo#core` or a loopback HTTP tarball URL. The consumer did not declare `core`. npm 12.2.2 rejected the peer with `EALLOWGIT` or `EALLOWREMOTE` when the corresponding setting was `root` and installed it with `all`. pnpm 12.21.0 installed and locked both forms with `--config.auto-install-peers=true --config.block-exotic-subdeps=true`. With peer auto-install disabled, pnpm reported the missing Git peer without installing it.

Background for the rejected `root` option: npm 12.2.2 accepts `--allow-git=root` for a Git dependency only if the install command lists the same dependency key and exact specifier. Installing a package alone whose Git runtime dependency is not listed failed with `EALLOWGIT`. The [workspace install-set test](../../tests/specs/workspace-publication.ts) now installs both shapes with `--allow-git=all`.

The table records which specifiers each manager treats as Git or exotic. It no longer selects the Git flags. The npm column is the parser result. For pnpm, `app` was installed over `git+file:` and declared each example as a runtime dependency. Hosted Git URLs and the generic `.git` URL were rewritten to a local repository with Git `insteadOf`; a loopback HTTP server served the tarball. Each row used a fresh consumer and store, with `pnpm install --config.block-exotic-subdeps=true` and again with `false`.

| `core` specifier in `app` | npm parser type | pnpm 12.21.0 with blocking enabled | With blocking disabled |
| --- | --- | --- | --- |
| `git+file:///path/to/repo#core` | `git` | `ERR_PNPM_EXOTIC_SUBDEP` | Installed |
| `git@github.com:example/core.git#core` | `git` | `ERR_PNPM_EXOTIC_SUBDEP` | Installed |
| `https://gitlab.com/example/core.git#core` | `git` | `ERR_PNPM_EXOTIC_SUBDEP` | Installed |
| Generic `http://host/core.git#core` or `https://host/core.git#core` | `remote` | `ERR_PNPM_EXOTIC_SUBDEP` | Installed |
| `ssh://git@host/core.git#core` | `EUNSUPPORTEDPROTOCOL` | `ERR_PNPM_EXOTIC_SUBDEP` | Installed |
| Direct `http://host/core.tgz` | `remote` | `ERR_PNPM_EXOTIC_SUBDEP` | Installed |
| `file:./core.tgz` (tarball available in consumer) | `file` | Installed | Installed |

## Experiment

Observed on Sun Nov 22 2026 with Node 26.13.0, Git 2.54.0, npm 12.2.2, pnpm 12.21.0, Yarn 4.18.1, and Bun 1.4.4, using local bare repositories. Yarn used an SSH URL rewritten to the local repository with `url.<path>.insteadOf`. No live GitHub transport was tested. Settings: npm `--allow-git=all`, pnpm `--config.block-exotic-subdeps=false`, Yarn `approvedGitRepositories`.

**Dedupe.** `app` declared `core` by bare branch as a runtime dependency and as a `*` peer, and the consumer also declared `core`. Without a colliding tag, all four managers loaded one copy (same real path, and `===` on an exported object), both with a byte-identical root specifier and with a `refs/heads/` or `head=` root specifier. With a colliding tag, mixing forms was unsafe: Bun installed two copies. So the root argument uses the same bare form as the manifests.

**Lockfiles and updates.** `A1`/`C1` are the first `app`/`core` commits and `A2`/`C2` the moved branch tips. Only `app` was a root dependency. Each column started from the first lockfile:

| Manager | Reinstall | Frozen or `ci` | Update `app` | Update `core` | No lockfile |
| --- | --- | --- | --- | --- | --- |
| npm | A1/C1 | A1/C1 | A2/C1 | A1/C2 | A2/C2 |
| pnpm | A1/C1 | A1/C1 | A2/C2 | A2/C2 | A2/C2 |
| Yarn | A1/C1 | A1/C1 | A2/C1 | A1/C2 | A2/C2 |
| Bun | A1/C1 | A1/C1 | A2/C2 | A1/C2 | A2/C2 |

Starting from the original lockfile in the bare-selector fixtures, naming both packages in one update advanced both commits on all four managers: `npm update app core`, `pnpm update app core`, `yarn up -R app core`, and `bun update app core`, with the same Git settings as the individual runs.

**Install cost.** One `app` with 20 internal branch dependencies in one repository, median of 3 installs with `node_modules` removed. This fixture used the qualified selectors, not bare ones. Cells are seconds and total Git subprocesses:

| Manager | Warm cache, lockfile | Warm, no lockfile | Cold cache, lockfile | Cold, no lockfile |
| --- | --- | --- | --- | --- |
| npm | 0.96 s, 42 | 1.58 s, 43 | 0.91 s, 42 | 1.56 s, 43 |
| pnpm | 0.06 s, 0 | 4.55 s, 147 | 4.50 s, 105 | 4.76 s, 147 |
| Yarn | 0.23 s, 0 | 0.34 s, 21 | 2.94 s, 42 | 3.65 s, 63 |
| Bun | 0.01 s, 0 | 0.22 s, 23 | 0.29 s, 44 | 0.47 s, 65 |

With a lockfile, npm still ran 42 `git ls-remote` calls for the 21-package fixture; pnpm, Yarn, and Bun ran no Git commands on a warm cache. These runs compared the same branch specs with and without a lockfile, not branch specs against commit pins.

**Migrating from commit pins.** A consumer locked to an `app` commit whose manifest pinned `core` by commit ran `update app` after `app` was republished with a branch reference. npm kept the old `core` commit after that update and on a clean `npm ci`; a fresh install with neither the previous lockfile nor `node_modules` selected the new `core`. pnpm, Yarn, and Bun moved to the new `core` after the update. A consumer that also had a direct commit pin for `core` got two copies in pnpm, Yarn, and Bun. Upgrade guidance: replace direct commit pins with the newly printed branch commands, then update every channel package.

## Precedent

- Published packages with moving dependencies exist but are rare: [`phoenix_live_view@1.2.9`](https://registry.npmjs.org/phoenix_live_view/1.2.9) shipped `morphdom` on `#main`, and [`@woocommerce/dependency-extraction-webpack-plugin@5.1.0`](https://registry.npmjs.org/@woocommerce%2fdependency-extraction-webpack-plugin/5.1.0) depended on the dist-tag `next`.
- [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new/blob/907d6cf9984ef144b89e96a1903496c337c0f26e/README.md#L139-L166) offers both commit URLs and moving per-PR URLs, and [Changesets](https://github.com/changesets/changesets/blob/704f329e541deebb6a39674ac6ef83c997bf5552/docs/guide/snapshot-releases.md#L69-L104) offers unique snapshot versions and a dist-tag. Both treat the moving form as a channel.
- [Cargo](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#specifying-dependencies-from-git) and [CocoaPods](https://guides.cocoapods.org/using/the-podfile.html) support branch dependencies with lockfiles pinning the commit.

An independent research pass recommended keeping commit pins, because a branch edge cannot reproduce the pairing git-publish published. That is the snapshot property this decision gives up on purpose. Revisit it if consumers need reproducible publication sets without a lockfile; the alternative is an opt-in snapshot mode that writes commit pins.
