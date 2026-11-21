# CLI

```sh
git-publish [packages...] [flags]
git-publish skills [--install <directory>]
```

Run `git-publish` inside a Git repository with a clean tracked working tree. It packs the committed source, so commit any edits you want to publish. Untracked files, including gitignored build output, are included when npm would pack them.

## Package selection

Without arguments, `git-publish` publishes the package in the current directory. In a workspace, positional arguments select packages by name, directory, or a quoted glob of package directories:

```sh
git-publish @acme/core ./packages/adapter './packages/plugins/*'
```

See [Monorepos](./monorepos.md) for what a selection publishes. `skills` is a subcommand, so select a workspace package named `skills` by its path, such as `./packages/skills`.

## Flags

| Flag | Description |
| --- | --- |
| `-r, --remote <remote>` | Git remote name or URL to push to. Default: `origin`. See [`--remote`](#--remote) |
| `-b, --branch <template>` | Branch name or template. See [Branches](#branches) |
| `-d, --dry` | Validate and print the publication plan. Does not pack, run package hooks, commit, or push |
| `-o, --fresh` | Publish a single-commit branch, replacing its history with a force-push. See [`--fresh`](#--fresh) |
| `--version-sha` | Record the source commit in each published `package.json`. See [`--version-sha`](#--version-sha) |
| `-f, --force` | Allow publishing a private standalone package or a private workspace root |
| `--json <path>` | Write publication details and install sets to a JSON file. See [JSON output](#json-output) |
| `-h, --help` | Show help |
| `--version` | Show the version |

## `--remote`

Every publication requires exactly one push URL. To publish to multiple destinations, use a separate remote per destination or pass `--remote <url>`, and run `git-publish` once per destination. Separate runs are not atomic across destinations and may produce different publication commits.

```sh
git-publish --remote origin
git-publish --remote mirror
```

## Branches

By default, a standalone package publishes to `npm/{gitRef}`, and each workspace package uses the template `npm/{gitRef}-{package}`. For a `core <- broker <- adapter` closure published from `feature/auth`:

```text
npm/feature/auth-@acme/core
npm/feature/auth-@acme/broker
npm/feature/auth-@acme/adapter
```

`--branch` accepts a literal name or a template with these placeholders:

- `{gitRef}`: The current branch, exact tag, or short commit fallback.
- `{gitSha}`: The full source commit object ID.
- `{package}`: The package name from `package.json`.

Quote templates in the shell:

```sh
git-publish --branch 'preview/{package}'
```

For one package, a literal branch stays exact: `git-publish --branch preview` publishes to `preview`. A multi-package publication must render a unique branch for every package, so include `{package}` when a literal name would collide.

## `--fresh`

By default, `git-publish` adds a commit to the existing branch. Lockfiles record the commit of a Git dependency, not the branch name, and a commit that becomes unreachable from the branch history may be garbage-collected, which breaks those installs. `--fresh` force-pushes a one-commit branch, so use it only when no one depends on the old commits.

## `--version-sha`

`--version-sha` records the source commit in each published `package.json`, so consumers can tell which source commit they installed:

```json
{
    "name": "@acme/core",
    "version": "1.2.3+sha-a1b2c3d",
    "gitHead": "<full source commit>"
}
```

The added `version` build metadata and `gitHead` together are the version SHA.

- `version` gets `+sha-<short commit>` semver build metadata. The short commit is the one the publication commit message names. A package without a `version` gets `0.0.0+sha-<short commit>`.
- `gitHead`, the field npm uses for the commit a package was built from, gets the full source commit ID.
- The version SHA, both `version` and `gitHead`, is written to `package.json` in the isolated checkout before packing. Lifecycle hooks and build scripts that run during packing can read both fields from `package.json`, and the SHA-suffixed version from `npm_package_version`. Files built before `git-publish` runs are not rewritten.
- A hook must not change the version. With npm, Yarn, and Bun, `git-publish` rejects a packed version that differs from the version with its SHA. pnpm drops build metadata when it packs, so with pnpm `git-publish` can't detect a script that removes the build metadata.
- Package managers ignore build metadata when they compare versions, so the version with its SHA satisfies every range that the source version satisfies. A prerelease such as `1.2.3-a1b2c3d` would not: npm rejects it against a `^1.2.0` peer range.
- When only the version SHA would change, `git-publish` reuses the existing publication commit, and its version SHA keeps naming the source commit it was published from. Reuse requires that:
  - All other files are identical, and no file mode changes, including the mode of `package.json`.
  - `package.json` gives the same `JSON.stringify` output after its version SHA fields are substituted. Formatting differences are ignored, but a change in the order of named keys is not.
  - The existing commit's version SHA and its message name the same source commit.

  Without `--fresh`, an unchanged package that meets these conditions keeps its publication commit. A build that writes the version SHA into a packed file changes that file on every source commit.
- The source version must parse as semver. node-semver normalizes forms such as `v1.2.3` to `1.2.3`. A version that does not parse, such as `1.2`, or that already has build metadata, such as `1.2.3+build.1`, is an error. So is a version with its SHA longer than node-semver's 256-character limit. A dry run reports the same error.

## JSON output

`--json <path>` writes publication details after a successful push. At a workspace root, a default selection of more than three packages prints a summary table instead of install commands; use the JSON file to get each install set.

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
        "@acme/core": {
            "required": [
                "@acme/core"
            ],
            "optional": []
        }
    },
    "aliases": {
        "@acme/core": {}
    }
}
```

- `source.commit` is the full source commit ID.
- Each package's `role` is `root`, `dependency`, or `peer`. `reused` is `true` when the existing publication commit was unchanged.
- Each install set lists the required and optional package names for one selected package. Look up their commit-pinned specifiers in `packages`.
- `aliases` maps each selected package to its internal runtime and peer aliases and their target package names. Install commands include required aliases as root arguments.

## `skills`

`git-publish` ships an [agent skill](https://agentskills.io) for coding agents.

```sh
# Print the skill
git-publish skills

# Copy it to <directory>/git-publish, creating missing directories
git-publish skills --install ~/.agents/skills
git-publish skills --install ~/.claude/skills
git-publish skills --install .agents/skills
```

`skills` works outside a Git repository. In a project that depends on git-publish, [pnpm agent skills](https://pnpm.io/agent-skills) can link the skill after approval instead.
