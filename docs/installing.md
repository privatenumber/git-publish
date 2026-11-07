# Installing a published package

After a push, `git-publish` prints the install command for your package manager. Run it in the project that should use the package.

## Install commands

A package with no internal workspace dependencies installs from the branch:

```sh
npm i 'owner/repo#npm/main'
```

For Yarn, the command uses `add` and includes the package name, which modern Yarn requires for Git dependencies:

```sh
yarn add 'my-package@https://github.com/owner/repo.git#npm/main'
```

A monorepo package prints one command that installs its whole set of packages as root dependencies, each pinned to its publish commit. Run the complete command; installing only the selected package needs broader consumer settings. Packages reachable only through optional dependencies install transitively.

Install URLs name the repository that receives the push. When a remote fetches from an upstream repository and pushes to your fork, the install URLs point at the fork.

## Package manager settings

Current package managers restrict Git dependencies by default. The consumer's project needs:

| Package manager | Setting |
| --- | --- |
| npm 12+ | `--allow-git=root` on the install command, or `allow-git=root` in `.npmrc`. Optional transitive Git dependencies need `allow-git=all`. |
| pnpm 11+ | `blockExoticSubdeps: false` in `pnpm-workspace.yaml` for an install set with more than one package. For one command: `pnpm add --config.block-exotic-subdeps=false <specifiers>` ([setting](https://pnpm.io/settings/dependency-resolution#blockexoticsubdeps)) |
| Yarn 4 | The repository in `approvedGitRepositories` in `.yarnrc.yml`, for every Git install |

For Git servers other than GitHub, GitLab, and Bitbucket, npm can ignore commit pins when the same package appears at different commits. `git-publish` warns when an install set contains several packages and the remote is on another host.

## Updating

A lockfile pins the commit, so a normal install keeps the old version. To move to a newer publish of a branch, run your package manager's update command, such as `npm update <name>`, `pnpm update <name>`, `bun update <name>`, or `yarn up -R <name>`. For a monorepo install set, run the newly printed command.

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
