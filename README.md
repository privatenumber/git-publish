# git-publish

Publish your npm package to a Git branch.
Useful for testing packages in production-like environments before publishing to npm.

<br>

<p align="center">
	<a href="https://github.com/sponsors/privatenumber/sponsorships?tier_id=398771"><img width="412" src="https://raw.githubusercontent.com/privatenumber/sponsors/master/banners/assets/donate.webp"></a>
	<a href="https://github.com/sponsors/privatenumber/sponsorships?tier_id=416984"><img width="412" src="https://raw.githubusercontent.com/privatenumber/sponsors/master/banners/assets/sponsor.webp"></a>
</p>

## Why?

To test a package without publishing to the npm registry. For example:

- Testing a package before it's ready for npm
- Contributing to a repo where you don't have publish access
- Testing in a CI/CD or remote environment where `npm link` doesn't work
- Avoiding symlink issues from `npm link`

### Why not use `npm publish`?

Publishing to npm just for testing has major downsides:

- **Versioning overhead:** You must bump the version, even for throwaway builds.
- **Permanent:** npm's [strict unpublish policy](https://docs.npmjs.com/policies/unpublish) makes removing test releases difficult.
- **Hard to inspect:** npm doesn't make it easy to view the contents of a published package.
- **Risky:** You could accidentally publish test code as a stable release.

### Why not use `npm link`?

- Skips [npm lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts#life-cycle-scripts)
- Links the entire project (including source, tests, configs)
- Doesn't install dependencies automatically

### So why `git-publish`?

- **No versioning required:** Uses Git branches instead of package versions.
- **Easy cleanup:** Delete the branch when you're done.
- **Browsable:** View and verify the published package on GitHub.
- **Safe:** Keeps test builds out of npm.
- **Realistic simulation:** Runs `prepare` and `prepack`, and includes only publishable files.

## Usage

### Publishing

Publish your npm package to a Git branch:

```sh
npx git-publish
```

This publishes the current package to the branch `npm/<current branch>` on the remote `origin`.

Or install `git-publish` globally and run `git-publish`:

```sh
npm install -g git-publish
```

### Installing the published package

After publishing, `git-publish` prints an install command for the published branch using the detected package manager:

```sh
npm i 'owner/repo#npm/main'
```

For Yarn, the command uses `add` and includes the package name, which modern Yarn requires for Git dependencies:

```sh
yarn add 'my-package@https://github.com/owner/repo.git#npm/main'
```

#### From a private repository

Package managers fetch Git dependencies with Git, so the installing machine needs access to the repo. On GitHub, pnpm 12+ always fetches over HTTPS, even for `git+ssh://` specifiers, so the same lockfile works on every machine with access ([details](https://pnpm.io/package-sources#how-git-dependencies-are-resolved)).

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

If the installing environment can't get access (e.g. a CI workflow in another repo), publish to a public repo with `--remote` instead:

```sh
npx git-publish --remote git@github.com:owner/public-repo.git --branch test-pkg
```

> [!WARNING]
> Minify or obfuscate private code before publishing to a public repo.

### CLI Flags

| Flag                    | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `-b, --branch <name>`   | Target branch name. Defaults to `npm/<current branch or tag>` |
| `-r, --remote <remote>` | Git remote name or URL to push to (default: `origin`)         |
| `-o, --fresh`           | Create a fresh single-commit branch. Force-pushes to remote   |
| `-d, --dry`             | Simulate the process. Does not commit or push                 |
| `-f, --force`           | Publish even if `package.json` has `"private": true`          |
| `-h, --help`            | Show CLI help                                                 |
| `--version`             | Show CLI version                                              |

## FAQ

### How do I include a build step?

Add your build command to the [`prepack`](https://docs.npmjs.com/cli/v11/using-npm/scripts#life-cycle-scripts) script in `package.json`:

```json5
{
    // ...

    "scripts": {
        "prepack": "npm run build",
    },
}
```

This mirrors the same behavior as `npm publish`.

### What does `git-publish` do?

1. Checks out or creates the publish branch
2. Packs the package with your package manager (`npm pack`, `pnpm pack`, `yarn pack`, or `bun pm pack`), which runs `prepare` and `prepack` and includes only publishable files
3. Commits the packed files
4. Pushes the branch to the Git remote
5. Prints the command to install the package via Git

### Why preserve commit history on the publish branch?

Lockfiles record the commit hash of a Git dependency, not the branch name. If that commit becomes unreachable from the branch history, it may be garbage-collected, breaking installs.

To avoid this, `git-publish` preserves history by default.

If you prefer a single clean commit and understand the risks, use the `--fresh` flag to force-push a one-commit branch.

### Why not just commit the files manually?

Manual commits often:

- Miss important files (e.g., those not in `dist/`)
- Include irrelevant files (e.g., tests, source, configs)
- Skip npm lifecycle scripts

`git-publish` avoids these pitfalls by packing with your package manager, like `npm publish` does.

### Can I use this in a monorepo?

Yes. Run `git-publish` from inside the specific package directory (e.g., `packages/my-lib`).

It will detect and publish only that package's contents to the root of the Git branch.

> [!IMPORTANT]
> Currently does not support resolving `workspace:` protocol dependencies. Avoid using those or pre-bundle them before publishing.

## Sponsors

<p align="center">
	<a href="https://github.com/sponsors/privatenumber">
		<img src="https://cdn.jsdelivr.net/gh/privatenumber/sponsors/sponsorkit/sponsors.svg">
	</a>
</p>
