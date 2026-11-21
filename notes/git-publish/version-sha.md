# Version SHA

`--version-sha` records the source commit in each published `package.json`. The version gets semver build metadata, `1.2.3+sha-<short>`, and `gitHead` gets the full source SHA. A package whose packed output didn't change keeps its previous publication commit and its previous version SHA, so in publication commits that git-publish created, the version SHA names the source commit in the commit message.

## Decision: build metadata, not a prerelease

A consumer installs a Git dependency by commit, so the version string only identifies the build. It must not change how ranges match.

- **Build metadata keeps every range match.** Semver ignores build metadata for precedence, so `1.2.3+sha-abc` satisfies the same ranges as `1.2.3`.
- **A prerelease breaks npm installs.** Semver sorts `1.2.3-abc` below `1.2.3`, and npm checks peers without `includePrerelease`. npm calls `semver.satisfies(child.version, requested.fetchSpec, true)` in [arborist dep-valid.js#L74 at v11.21.3](https://github.com/npm/cli/blob/v11.21.3/workspaces/arborist/lib/dep-valid.js#L74). git-publish's own packed-range validation follows the same rule for ordinary ranges such as `^1.2.0` ([satisfies-range.ts](../../src/workspace-publication/satisfies-range.ts)). It enables `includePrerelease` only for `*` and an empty range, and otherwise uses node-semver's default matching, where a range such as `^1.2.3-rc.1` still accepts `1.2.3-rc.2`.
- **Registry objections don't apply.** Lerna moved its canary versions from `+<sha>` to a prerelease in [lerna#4402](https://github.com/lerna/lerna/pull/4402). Its reasons were that the npm registry strips build metadata on publish ([libnpmpublish publish.js#L82-L89 at v11.21.3](https://github.com/npm/cli/blob/v11.21.3/workspaces/libnpmpublish/lib/publish.js#L82-L89): `const version = semver.clean(manifest.version)`) and that JFrog Artifactory can't install such versions. Both are registry problems. git-publish doesn't publish to a registry.
- **Precedent.** Angular's snapshot builds are also published to Git repositories and installed as Git dependencies. They use `<version>+sha-<7 chars>` ([env-stamp.ts#L62-L83 at aba3adc](https://github.com/angular/dev-infra/blob/aba3adc53489fee586e2375ee4367ff30c947390/ng-dev/release/stamping/env-stamp.ts#L62-L83)). The `sha-` prefix keeps the identifier from being all digits.

### Install experiment

On Fri Nov 20 2026, on macOS with Node.js 26.13.0, npm 12.2.2, pnpm 12.18.0, Yarn 4.18.1, and Bun 1.4.4:

- **Setup.** One local Git repository holds package `b`. Another holds package `a`, which has `peerDependencies: { "b": "^1.2.0" }`.
- **Install.** A consumer depends on both by commit and installs them. The URLs are `git+file://…#<commit>` for npm (with `--allow-git=all`), pnpm, and Bun. Yarn rejects `git+file:` URLs, so for Yarn the URLs are `https://…#commit=<commit>`, mapped to the local repositories with `url.<path>.insteadOf`.

| `b` version | npm | pnpm | Yarn | Bun |
| --- | --- | --- | --- | --- |
| `1.2.3+abc1234` | installs | installs | installs | installs |
| `1.2.3-abc1234` | `ERESOLVE unable to resolve dependency tree` … `peer b@"^1.2.0" from a@1.0.0` | installs; `pnpm peers check` reports no issues | installs | installs |

With `1.2.3+abc1234`, all four package managers left `node_modules/b/package.json` at exactly `1.2.3+abc1234`. npm, pnpm, and Yarn wrote `1.2.3+abc1234` to the lockfile (`bun.lock` records only the commit), and `npm ls` printed `b@1.2.3+abc1234`. No package manager rewrites the installed file. npm's `semver.clean` normalization runs in `npm publish` and `npm version`, but not when Arborist loads an installed package, which uses `@npmcli/package-json` `normalize()` without `normalizeData` ([index.js#L40-L51 at v8.0.1](https://github.com/npm/package-json/blob/v8.0.1/lib/index.js#L40-L51)).

## Decision: write the version SHA before packing and again after

A package can read its own version during the build, for example to bundle a CLI's `--version`. So git-publish writes the version SHA into the isolated pack checkout before packing. The packed manifest is not reliable, though, so git-publish sets the version SHA again after packing:

| Package manager | Packed `version` for source `1.2.3+abc1234` | Version a `prepack` hook sees |
| --- | --- | --- |
| npm 12.2.2 | `1.2.3+abc1234` | `1.2.3+abc1234` |
| pnpm 12.18.0 | `1.2.3` | `1.2.3+abc1234` |
| Yarn 4.18.1 | `1.2.3+abc1234` | `1.2.3+abc1234` |
| Bun 1.4.4 | `1.2.3+abc1234` | `1.2.3+abc1234` |

The hook column shows both `npm_package_version` and `require('./package.json').version`, which agreed in every run. pnpm also names the tarball `p-1.2.3.tgz`, while npm and Bun name it `p-1.2.3+abc1234.tgz`. pnpm strips the metadata on purpose, "so the tarball name, the packed manifest and any registry metadata all agree on the version" ([source.rs#L105-L129 at v12.18.0](https://github.com/pnpm/pnpm/blob/v12.18.0/pnpm/crates/pack/src/source.rs#L105-L129), using `strip_build_metadata` in [output.rs#L196-L199](https://github.com/pnpm/pnpm/blob/v12.18.0/pnpm/crates/pack/src/output.rs#L196-L199)).

After packing, npm, Yarn, and Bun must produce exactly the version with its SHA. For pnpm, git-publish also accepts that version without its build metadata. Any other packed version fails the publication. The pnpm exception has a limit: pnpm strips the metadata after it reads the manifest, so git-publish can't tell pnpm's stripping from a lifecycle script that removed the version SHA. In both cases git-publish sets the version SHA again, but a build output that embedded the version without its SHA keeps that version.

## Decision: the source commit, with reuse that ignores the version SHA

The version SHA names the commit that was checked out and packed (HEAD), not the last commit that touched the package's directory.

- **A directory SHA claims more than it proves.** A package's output also depends on files outside its directory, such as the root lockfile, shared build configuration, and workspace dependencies. A change to those files would publish new content under an old SHA.
- **A directory SHA is wrong in shallow clones.** CI checkouts often fetch one commit. `git log -1 -- <dir>` then returns the shallow boundary commit for every directory.
- **Precedent embeds the built commit.** Lerna canaries ([make-canary-version.ts at v10.1.3](https://github.com/lerna/lerna/blob/v10.1.3/libs/commands/publish/src/lib/make-canary-version.ts)), Angular snapshot builds, and React canaries ([build-all-release-channels.js at e04279e](https://github.com/facebook/react/blob/e04279e76e2703ceb0d99c3599f0b74f01770dd4/scripts/rollup/build-all-release-channels.js#L24-L47)) use the current commit. Changesets snapshots use it only when the configured template asks for `{commit}` ([assemble-release-plan at 9a035ec](https://github.com/changesets/changesets/blob/9a035ec36045aeb6141dd0bbac9ab9e3c69ac0bc/packages/assemble-release-plan/src/index.ts#L37-L106)). pkg.pr.new `--previewVersion` uses HEAD and falls back to the CI workflow's SHA ([cli/index.ts at 907d6cf](https://github.com/stackblitz-labs/pkg.pr.new/blob/907d6cf9984ef144b89e96a1903496c337c0f26e/packages/cli/index.ts#L462-L466)). A search of public code found no tool that records a directory's last change in the version. That is a null result, not proof that none exists.

A HEAD version SHA alone would change every package's `package.json` on every source commit. git-publish reuses the branch tip when the packed tree is unchanged, so every unchanged package would then get a new commit and a new install specifier on every publish. To keep reuse, the comparison with the tip ignores the version SHA: if the tip has a version SHA and the new tree differs only in `version` and `gitHead`, git-publish keeps the tip, including its old version SHA. The tip's version SHA and commit message both name the earlier source commit, and that commit produced the same output. git-publish only reuses a tip whose version SHA is well formed (`sha-` and lowercase hex on the same base version, and a full-SHA `gitHead` that starts with that hex), whose `package.json` file mode is unchanged, and whose commit message names the same short commit as its version SHA.

The message check matters because a `version` shaped like a version SHA doesn't prove that `--version-sha` wrote it. A review reproduced this case: a publication made without the flag, whose `prepack` hook copied a prebuilt artifact's real provenance into `version` and `gitHead`. Without the message check, a later run with `--version-sha` reused that commit, and its version SHA named a different source commit than its message. The check applies to both reuse paths, the exact-tree match and a difference only in the version SHA.

The comparison parses both `package.json` files and compares their `JSON.stringify` output, with the tip's `version` and `gitHead` put into the new manifest. So with `--version-sha`, a change that only reformats `package.json` also keeps the tip, while without the flag the byte difference creates a new commit. That is accepted, because consumers read the same JSON either way. A change in the order of named keys is not ignored, because `JSON.stringify` keeps insertion order for them, so it creates a new commit. Array-index keys, the canonical decimal strings from `"0"` through `"4294967294"`, are always serialized in numeric order, so their order is ignored. Keys such as `"01"` keep insertion order. The commit subject is read with `--no-show-signature` and `--encoding=UTF-8`, so the user's `log.showSignature` and `i18n.logOutputEncoding` settings don't change it. A byte-exact comparison would need extra code to read the parent blob's exact bytes, because the repository's output helper trims command output.

A package whose pack-time build reads the manifest with the version SHA and embeds the full version gets a new commit on every source commit, because its output really changes. A build that reads another manifest or embeds only the base version doesn't. Prebuilt files that are copied into the checkout are not rewritten, so they keep whatever version they were built with.

**Cost.** The rejected directory lookup was measured too, so cost was not the reason to reject it. On Fri Nov 20 2026 (macOS, Git 2.54.0), a loop ran `git log -1 --format=%H HEAD -- <dir>` for each directory under `packages/` in local clones without a commit-graph:

| Repository | Commits | Packages | All packages, sequential | Slowest package |
| --- | --- | --- | --- | --- |
| [vercel/ai](https://github.com/vercel/ai) | 8,578 | 80 | 1,421 ms | 57 ms |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | 22,597 | 33 | 885 ms | 118 ms |

Packing one package takes seconds, so this would be small in comparison. The reuse check that ignores the version SHA is cheaper. With a version SHA and an existing tip, a changed tree costs one tree diff. Only when `package.json` is the only changed entry does git-publish also read one blob. It reads the tip's commit subject only for a candidate that passed the tree checks, including an exact tree match.

## Rejected alternatives

- **A prerelease version**, such as Changesets snapshots (`0.0.0-<tag>-<datetime>`), pkg.pr.new `--previewVersion` (`0.0.0-preview-<sha>`), or Lerna 10 canaries (`1.1.0-alpha.0.sha-<sha>`). These are precedents for the version format only. For Git dependencies the commit pins the install, so a prerelease adds nothing, and it breaks range checks: npm's peer check, as the experiment shows, and git-publish's own dependency and peer validation ([validate.ts](../../src/package-publication/validate.ts)), which uses the same semver rule.
- **A version template**, like Changesets' `snapshot.prereleaseTemplate`. One fixed format covers the need. Revisit if users need a different format.
- **`_`-prefixed fields**, such as `_gitHead`. Arborist deletes keys starting with `_` from the manifest it loads ([normalize.js#L193-L201 at v8.0.1](https://github.com/npm/package-json/blob/v8.0.1/lib/normalize.js#L193-L201)).

Revisit this decision if a supported package manager starts rewriting or rejecting build metadata in installed Git dependencies, or starts accepting prereleases in peer checks.
