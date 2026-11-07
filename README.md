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
| `-b, --branch <template>` | Target branch template. Supports `{gitRef}`, `{gitSha}`, and `{package}` |
| `-r, --remote <remote>` | Git remote name or URL to push to (default: `origin`)         |
| `-o, --fresh`           | Create a fresh single-commit branch. Force-pushes to remote   |
| `-d, --dry`             | Simulate the process. Does not commit or push                 |
| `-f, --force`           | Publish a private workspace root or standalone package        |
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

`git-publish` checks each positive `package.json` `"files"` entry from the packed package after lifecycle hooks run. If an entry matches no packed file or directory, it warns and still publishes. That usually means the build did not run, or the entry is wrong.

You can also run the build before `git-publish`. Existing build output, including gitignored files such as `dist/`, is included when it matches the package's `files` field. See [Preparing monorepo packages](#preparing-monorepo-packages) for workspace builds and custom hooks in a fork.

### What does `git-publish` do?

1. Checks out or creates the publish branch
2. Packs the package with your package manager (`npm pack`, `pnpm pack`, `yarn pack`, or `bun pm pack`), which runs `prepare` and `prepack` and includes only publishable files
3. Removes `prepare`, `prepack`, and `build` scripts and the `workspaces` field from the packed manifest, then commits the packed files. Install lifecycle scripts remain intact.
4. Pushes the branch to the Git remote
5. Prints the command to install the package via Git

Install URLs name the repository that receives the push.

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

Yes. Run `git-publish` inside a package directory to select that package; at the workspace root, it selects the root package if it is named and public, or every non-private member if the root is private or unnamed.

You can select packages by name, directory, or a quoted glob of package directories:

```sh
git-publish @acme/core ./packages/adapter './packages/plugins/*'
```

`git-publish` publishes the selected packages and their internal runtime and peer dependencies. For npm, Yarn, and Bun, a plain semver range also selects a workspace package when its version satisfies that range. For pnpm, internal edges must use `workspace:`. Each package commit is created before one atomic push, so a failed branch update does not expose a partial dependency closure.

`--branch` accepts a small branch template with these placeholders:

- `{gitRef}`: The current branch, exact tag, or short commit fallback.
- `{gitSha}`: The full source commit object ID.
- `{package}`: The package name from `package.json`.

Quote branch templates in the shell, for example `'preview/{package}'`.

When `--branch` is omitted, workspace packages use the default template `npm/{gitRef}-{package}`. For a `core <- broker <- adapter` closure published from `feature/auth`, it creates:

```text
npm/feature/auth-@acme/core
npm/feature/auth-@acme/broker
npm/feature/auth-@acme/adapter
```

Pass a template to choose each workspace branch independently:

```sh
git-publish --branch 'preview/{package}'
```

For one package, a literal branch remains exact. For example, `git-publish --branch preview` publishes to `preview`. A multi-package workspace closure must render a unique branch for every package. Include `{package}` when a literal template would collide.

Standalone packages keep the default `npm/<gitRef>` branch. An explicit `--branch` can use the same placeholders or remain a literal branch name.

Internal peers retain their packed ranges. Publication fails before pushing if a packed peer range does not match its target's packed version. Unresolved `workspace:` peers are reported so consumers can provide them.

For each selected package, the install command includes its runtime and peer closure as root dependencies. The commit-pinned Git URLs match those in the packed manifests. A single-package install uses the moving branch reference instead.

- npm 12+: add `--allow-git=root` to the command for any Git install.
- pnpm 11+: set `blockExoticSubdeps: false` in the consumer's `pnpm-workspace.yaml` for a multi-package install set.
- Yarn 4: add the repository to `approvedGitRepositories` in the consumer's `.yarnrc.yml`.

For non-hosted Git URLs, npm can ignore commit pins when the same package appears at different commits. `git-publish` warns when an install set contains multiple packages and the remote is not on GitHub, GitLab, or Bitbucket.

Use `--json <path>` to write publication details after a successful push. At the workspace root, a default selection of more than three packages prints a summary table instead of install commands; use the JSON file to get each install set.

```json
{
    "source": {
        "ref": "main",
        "commit": "<source commit>"
    },
    "packages": [
        {
            "name": "@acme/core",
            "branch": "npm/main-@acme/core",
            "commit": "<publish commit>",
            "installSpecifier": "git+https://github.com/acme/repo.git#<publish commit>",
            "role": "root",
            "reused": false
        }
    ],
    "installSets": {
        "@acme/core": [
            "@acme/core"
        ]
    },
    "aliases": {
        "@acme/core": {}
    }
}
```

Each package's `role` is `root`, `dependency`, or `peer`. `reused` is true when the existing publication commit was unchanged. `source.commit` is the full commit ID, or `null` when the source has no commit. Install-set values are package names; look up their commit-pinned specifiers in `packages`.

`aliases` maps each root to its internal dependency aliases and target package names. npm 12 requires `--allow-git=all` when an install set contains an alias.

> [!IMPORTANT]
> A recursive publication requires one push URL. Git cannot atomically push one dependency closure to multiple destinations.

#### Preparing monorepo packages

Install the repository's dependencies before publishing so the package manager can resolve [`workspace:` references](https://pnpm.io/workspaces#workspace-protocol-workspace) and run package hooks. `git-publish` does not automatically run a script named `build`.

If the repository has a workspace build command, run it before publishing. For example, in a pnpm monorepo with a root `build` script and a remote named `fork` pointing to your fork:

```sh
# From the repository root
pnpm install
pnpm build
cd packages/my-lib
git-publish --remote fork
```

Use the repository's documented build command to generate output for the selected package and all its required workspace dependencies. Each package's `files` field must include its build output.

If packages need custom preparation, add or adjust their `prepack` scripts in your fork's `package.json` files. Each package can use its own command. Commit the manifest and source changes before running `git-publish`: it requires a clean tracked working tree and packs from the committed source. Gitignored build output does not need to be committed.

Package hooks run in an isolated checkout that is cleaned between packages. If one package's build needs another package's generated files, build those dependencies in your source checkout first; do not rely on output from an earlier package's pack hook being retained for the next package.

#### Installing with pnpm

pnpm can block a Git dependency declared by another Git dependency with [`blockExoticSubdeps`](https://pnpm.io/settings/dependency-resolution#blockexoticsubdeps). A consumer that installs a published workspace closure must opt in:

```sh
pnpm add --config.block-exotic-subdeps=false '<install-specifier>'
```

## Sponsors

<p align="center">
	<a href="https://github.com/sponsors/privatenumber">
		<img src="https://cdn.jsdelivr.net/gh/privatenumber/sponsors/sponsorkit/sponsors.svg">
	</a>
</p>
