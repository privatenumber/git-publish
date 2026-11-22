# Installing a published package

After a push, `git-publish` prints the install command for your package manager. Run it in the project that should use the package.

## Install commands

Install a published package from its branch:

```sh
npm i --allow-git=root 'owner/repo#npm/main'
```

For Yarn, the command uses `add` and includes the package name, which modern Yarn requires for Git dependencies:

```sh
yarn add 'my-package@https://github.com/owner/repo.git#npm/main'
```

Install URLs use the bare branch name (`#<branch>`). Before packing, `git-publish` [validates rendered branch names](./cli.md#branches) and checks for conflicting refs, such as a same-named tag or a pull request ref that a package manager could resolve instead of the branch. The check can miss unusual ref spellings and cannot prevent someone from adding a conflicting ref later.

If a `pushInsteadOf` rule applies to the publish client's remote, the conflict check reads that remote's fetch URL while the push uses the rewritten URL. The check may therefore read a different repository.

For a monorepo package, the command includes the selected package and any required internal peers. Package managers install runtime dependencies transitively from the branch URLs in the published manifests. They also attempt optional workspace dependencies, but may skip them, for example when a required peer is missing. Use the printed peer command to supply that peer when applicable. If a package appears both in the main command and as a runtime dependency, both use the same Git specifier.

With Yarn Plug'n'Play and `pnpFallbackMode: none`, installing a peer at the root does not supply it through an intermediate package. If `a` depends on `b` and `b` needs peer `c`, declare `c` as a peer of `a` too so Yarn can pass the root's `c` through.

With an explicit push URL to a fork, install URLs point at the fork rather than the upstream repository. For publications with internal dependencies, the command uses the same Git URL form as the manifest. Yarn also keeps explicit GitHub SSH URLs for single packages because it expands GitHub shorthand to HTTPS.

## Package manager settings

The printed install and optional-peer commands include the npm or pnpm flags they need. These flags apply only to that invocation. They cover the dependencies declared in the published packages' manifests. Git or tarball dependencies of other registry packages, or the project's existing dependencies, can still need broader settings.

| Package manager | Setting |
| --- | --- |
| npm 12+ | The command uses `--allow-git=root` unless npm fetches a Git dependency not listed directly with the same specifier, in which case it uses `--allow-git=all`. It includes `--allow-remote=all` when npm installs dependencies or required peers from direct HTTP(S) tarball URLs. Save the same `allow-git` value in the project's `.npmrc` to avoid `EALLOWGIT` on `npm ci`, clean installs, and updates. If the command also includes `--allow-remote=all`, save `allow-remote=all` there too to avoid `EALLOWREMOTE`. A command-line flag overrides `.npmrc`, so if the project already sets `allow-git=all`, keep it and drop `--allow-git=root` from the command. |
| pnpm 11+ | The command uses `--config.block-exotic-subdeps=false` when runtime or optional dependencies use Git or direct tarball URLs. Local `file:` dependencies do not need it. pnpm 12.21.0 also allows auto-installed required peers with these URLs without it. For updates, pass the flag again or set [`blockExoticSubdeps: false`](https://pnpm.io/settings/dependency-resolution#blockexoticsubdeps) in `pnpm-workspace.yaml`. Installs from the lockfile do not need it. |
| Yarn 4 | The repository in `approvedGitRepositories` in `.yarnrc.yml`, for every Git install. Local-file remotes do not work with Yarn 4.18.1: it rejects `git+file:` URLs even when approved. Use an HTTPS or SSH remote instead. |
| Bun | No Git dependency setting required |

For npm installs from a non-hosted remote, the remote's `HEAD` must point to an existing branch. A new bare remote that only receives publish branches may still point to an unborn default branch. Set `HEAD` on the server to an existing branch. See the [npm remote HEAD requirement](../notes/git-publish/remote-urls.md#npm-needs-the-remotes-head-to-resolve).

## Updating

Publish branches work like a prerelease dist-tag such as `beta`: a fresh install selects the current branch tips, while your lockfile pins the commits it resolved. A normal locked reinstall does not advance them.

To refresh the whole channel, update every channel package by its install key, including transitive dependencies. For an unaliased `core` dependency, run `npm update app core`, `pnpm update app core`, `bun update app core`, or `yarn up -R app core`. If `app` declares `core` under the key `my-core`, run `npm update app my-core`: `npm update app core` can leave the alias at its old commit. A fresh install with neither the previous lockfile nor `node_modules` also resolves the current tips, but can update unrelated dependencies. Deleting only the lockfile can leave npm using the commits already installed in `node_modules`.

If you are migrating from a commit-pinned publication, replace any direct commit pins with the newly printed branch commands. Then update the channel packages by install key, for example `npm update app my-core` if `app` declares `core` as `my-core`.

A saved command is not a snapshot. If an internal peer was published on its own with an incompatible version, the package manager can report a peer mismatch. Publish versions that satisfy the peer range before updating the consumer.

## Private repositories

Package managers fetch Git dependencies with Git, so the installing machine needs access to the repository. On GitHub, pnpm 12+ always fetches over HTTPS, even for `git+ssh://` specifiers, so the same lockfile works on every machine with access ([details](https://pnpm.io/package-sources#how-git-dependencies-are-resolved)).

Configure Git once per machine:

| | `gh auth setup-git` (recommended) | SSH URL rewrite |
| --- | --- | --- |
| Authenticates with | Your [GitHub CLI](https://cli.github.com) login, over HTTPS | Your SSH key |
| Covers | Every repo your account can read | Only the owners you list |
| Use when | You use the GitHub CLI. CI authenticates the same way, with an HTTPS token. | You prefer SSH keys, or use several GitHub accounts |

```sh
gh auth setup-git

# or
git config --global url."git@github.com:owner/".insteadOf "https://github.com/owner/"
```

Scope the rewrite to an owner. Rewriting all of `https://github.com/` also moves unrelated tools to SSH, which can break them.

`git-publish` removes credentials from every URL it writes or prints, so tokens in remote URLs never reach published manifests.

If the installing environment can't get access, such as a CI workflow in another repository, publish to a public repository with `--remote` instead:

```sh
npx git-publish --remote git@github.com:owner/public-repo.git --branch test-pkg
```

> [!WARNING]
> Minify or obfuscate private code before publishing it to a public repository.
