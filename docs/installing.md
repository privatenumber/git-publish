# Installing a published package

After a push, `git-publish` prints the install command for your package manager. Run it in the project that should use the package.

## Install commands

Install a published package from its branch:

```sh
npm i 'owner/repo#npm/main'
```

For Yarn, the command uses `add` and includes the package name, which modern Yarn requires for Git dependencies:

```sh
yarn add 'my-package@https://github.com/owner/repo.git#npm/main'
```

Install URLs use the bare branch name (`#<branch>`). `git-publish` [validates rendered branch names](./cli.md#branches) before packing. Do not create tags with the same name as a publish branch. Package managers can resolve the tag instead of the branch. `git-publish` checks for existing tags before packing, but cannot prevent someone from adding one later.

For a monorepo package, the command includes the selected package and any required internal peers. Package managers install runtime dependencies transitively from the branch URLs in the published manifests. They also attempt optional workspace dependencies, but may skip them, for example when a required peer is missing. Use the printed peer command to supply that peer when applicable. If a package appears both in the main command and as a runtime dependency, both use the same Git specifier.

Install URLs name the repository that receives the push. When a remote fetches from an upstream repository and pushes to your fork, the install URLs point at the fork. For publications with internal dependencies, the command uses the same Git URL form as the manifest. Yarn also keeps explicit GitHub SSH URLs for single packages because it expands GitHub shorthand to HTTPS.

## Package manager settings

Current package managers restrict Git dependencies by default. The consumer's project needs:

| Package manager | Setting |
| --- | --- |
| npm 12+ | `--allow-git=all` on the install command (or `allow-git=all` in `.npmrc`) when the package has Git runtime or optional dependencies. If all Git dependencies are direct, use `--allow-git=root` or `allow-git=root` instead. |
| pnpm 11+ | `blockExoticSubdeps: false` in `pnpm-workspace.yaml` when the package has Git runtime or optional dependencies. For one command: `pnpm add --config.block-exotic-subdeps=false <specifiers>` ([setting](https://pnpm.io/settings/dependency-resolution#blockexoticsubdeps)) |
| Yarn 4 | The repository in `approvedGitRepositories` in `.yarnrc.yml`, for every Git install |
| Bun | No Git dependency setting required |

## Updating

Publish branches work like a prerelease dist-tag such as `beta`: a fresh install selects the current branch tips, while your lockfile pins the commits it resolved. A normal locked reinstall does not advance them.

To refresh the whole channel, update every channel package by name, including transitive dependencies. For example, run `npm update app core`, `pnpm update app core`, `bun update app core`, or `yarn up -R app core`. Updating `app` alone can leave `core` at its old commit. Installing without a lockfile also resolves the current tips, but can update unrelated dependencies.

If you are migrating from a commit-pinned publication, replace any direct commit pins with the newly printed branch commands, then update the channel packages by name.

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
