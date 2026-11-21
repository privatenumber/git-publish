# Branches as a prerelease channel

**Decision (Sun Nov 22 2026).** git-publish publishes a prerelease channel, in the same way that an npm dist-tag such as `beta` is a channel. Published manifests reference internal workspace dependencies by their moving publish branch, such as `git+ssh://git@github.com/o/r.git#npm/core`, and never by commit. Printed install commands use the same branch references. The consumer's lockfile pins commits. git-publish refuses to publish when the remote has a tag with the same name as a publish branch.

This replaces the commit-pinned design in [Monorepo install sets](./monorepo-install-sets.md), where each dependent's manifest pinned its internal dependencies to the commits published with it.

## Why

- **The channel model is the intended contract.** Installing `"b": "beta"` can pair a dependent with a newer `b` than the one it was tested with. The user chose the same risk for git-publish: a prerelease channel may deliver breaking changes, and the lockfile is what makes an install reproducible.
- **A new dependency commit no longer changes the dependent's manifest.** With commit pins, a new publication commit for `core` changes every manifest that pins it. A branch reference stays the same, so dependents can reuse their commits if their packed files are unchanged. A build hook that embeds dependency output can still change those files.
- **Packing no longer needs dependency order for commit content.** [Publication performance](./publication-performance.md) records that commit preparation used to need the commits of its dependencies. A branch reference is known before anything is packed. Runtime compatibility checks still use the target's packed version during preparation; peer ranges are checked after packing.
- **One specifier form everywhere.** The root argument and the nested dependency use byte-identical specifiers, so there is no special case for a package that is both a peer and a runtime dependency.

## What this gives up

- **A publication is no longer a snapshot.** Resolving a saved command without a lockfile gets the current branch tips, not the commits published together. git-publish validates dependency and peer ranges against the packages published in the same run. A dependency published alone later can be incompatible, and a package manager can report a peer range mismatch.
- **The atomic push is not an atomic install.** git-publish updates multiple branches in one `git push --atomic`, but a package manager can resolve one branch before the push and another after it.
- **Updates differ by package manager.** In the experiment below, `npm update app` moved `app` but not `core`, while pnpm and Bun moved both. To follow the whole channel, update every channel package by name, or reinstall without the lockfile.

## Selector choice

A published manifest is read by whichever package manager the consumer uses, so its selector must work in all of them. Of the selectors tested, only the bare branch name did.

Nested dependency `core` declared by `app` with each selector. Each cell is "no same-named tag → a tag named `npm/core` at a different commit":

| Manager | `#npm/core` | `#refs/heads/npm/core` | `#head=npm/core` |
| --- | --- | --- | --- |
| npm 12.2.2 | Branch → branch content, but the lockfile records the tag commit | Branch → branch | Rejected |
| pnpm 12.21.0 | Branch → tag | Branch → branch | Rejected |
| Yarn 4.18.1 | Branch → tag | Rejected | Branch → branch |
| Bun 1.4.4 | Branch → tag | Branch → branch | Rejected |

No tested selector is both accepted by all four managers and unambiguous. The bare name is accepted by all four, so git-publish uses it and checks the remote for tags with publish branch names before packing. A dry run reads local remote config without contacting the remote and does not perform this check. The check cannot stop a tag created after the lookup, so the docs tell users not to create tags with publish branch names. In the npm collision fixture, `npm ci` installed branch content that differed from the commit in the lockfile.

Bare selectors are portable for the tested ordinary branch names, not for every valid Git ref. With a direct dependency in `package.json`, pnpm 12.21.0 failed to install `#npm/a&b`, and Bun 1.4.4 failed to install `#npm/a#b`, both over `git+file:`. `npm/a+b`, `npm/a=b`, and `npm/a%b` worked in all four tested managers. Avoid `&` and `#` in custom publish branch names.

Upstream selector behavior, at the inspected versions:

- npm: a bare name takes the last advertised ref with that short name ([lines-to-revs.js at v12.2.3](https://github.com/npm/cli/blob/v12.2.3/node_modules/@npmcli/git/lib/lines-to-revs.js#L100-L135)).
- pnpm: a bare name prefers a tag ([resolve_ref.rs at v12.21.0](https://github.com/pnpm/pnpm/blob/v12.21.0/pnpm/crates/resolving-git-resolver/src/resolve_ref.rs#L159-L177)).
- Yarn: a bare name tries a commit, then a tag, then a branch; `head=` selects a branch ([gitUtils.ts at 4.18.1](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.18.1/packages/plugin-git/sources/gitUtils.ts#L182-L240)).
- Bun: the selector goes to `git log`, so Git's ref precedence applies ([git_runner.rs at bun-v1.4.5](https://github.com/oven-sh/bun/blob/bun-v1.4.5/src/install/git_runner.rs#L1067-L1103), [gitrevisions](https://git-scm.com/docs/gitrevisions)).

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

**Migrating from commit pins.** A consumer locked to an `app` commit whose manifest pinned `core` by commit ran `update app` after `app` was republished with a branch reference. npm kept the old `core` commit after that update and on a clean `npm ci`; a fresh install without the lockfile selected the new `core`. pnpm, Yarn, and Bun moved to the new `core` after the update. A consumer that also had a direct commit pin for `core` got two copies in pnpm, Yarn, and Bun. Upgrade guidance: replace direct commit pins with the newly printed branch commands, then update every channel package.

## Precedent

- Published packages with moving dependencies exist but are rare: [`phoenix_live_view@1.2.9`](https://registry.npmjs.org/phoenix_live_view/1.2.9) shipped `morphdom` on `#main`, and [`@woocommerce/dependency-extraction-webpack-plugin@5.1.0`](https://registry.npmjs.org/@woocommerce%2fdependency-extraction-webpack-plugin/5.1.0) depended on the dist-tag `next`.
- [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new/blob/907d6cf9984ef144b89e96a1903496c337c0f26e/README.md#L139-L166) offers both commit URLs and moving per-PR URLs, and [Changesets](https://github.com/changesets/changesets/blob/704f329e541deebb6a39674ac6ef83c997bf5552/docs/guide/snapshot-releases.md#L69-L104) offers unique snapshot versions and a dist-tag. Both treat the moving form as a channel.
- [Cargo](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#specifying-dependencies-from-git) and [CocoaPods](https://guides.cocoapods.org/using/the-podfile.html) support branch dependencies with lockfiles pinning the commit.

An independent research pass recommended keeping commit pins, because a branch edge cannot reproduce the pairing git-publish published. That is the snapshot property this decision gives up on purpose. Revisit it if consumers need reproducible publication sets without a lockfile; the alternative is an opt-in snapshot mode that writes commit pins.
