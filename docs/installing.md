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

For a monorepo package, the command includes the selected package and any required internal peers. Internal runtime dependencies, including optional ones, install transitively from the commit-pinned URLs in the published manifests. If an argument also appears as a runtime dependency in that package's published closure, the command uses the same commit-pinned URL instead of the branch.

Install URLs name the repository that receives the push. When a remote fetches from an upstream repository and pushes to your fork, the install URLs point at the fork.

## Package manager settings

Current package managers restrict Git dependencies by default. The consumer's project needs:

| Package manager | Setting |
| --- | --- |
| npm 12+ | `--allow-git=all` on the install command (or `allow-git=all` in `.npmrc`) when the package has internal Git runtime dependencies. If all Git dependencies are direct, use `--allow-git=root` or `allow-git=root` instead. |
| pnpm 11+ | `blockExoticSubdeps: false` in `pnpm-workspace.yaml` when the package has internal Git runtime dependencies. For one command: `pnpm add --config.block-exotic-subdeps=false <specifiers>` ([setting](https://pnpm.io/settings/dependency-resolution#blockexoticsubdeps)) |
| Yarn 4 | The repository in `approvedGitRepositories` in `.yarnrc.yml`, for every Git install |
| Bun | No Git dependency setting required |

For Git servers other than GitHub, GitLab, and Bitbucket, npm can ignore commit pins when the same package appears at different commits. For example, an existing direct dependency can override a different transitive pin. `git-publish` warns when the publication contains internal Git runtime dependencies and the remote is on another host.

## Updating

A lockfile pins the commit, so a normal install keeps the old version. To move to a newer publish of a branch, run your package manager's update command, such as `npm update <name>`, `pnpm update <name>`, `bun update <name>`, or `yarn up -R <name>`. If the command includes any commit-pinned arguments, run the newly printed command to update those arguments too.

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
