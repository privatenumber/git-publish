# CLI

```sh
git-publish [packages...] [flags]
git-publish skills [--install <directory>]
```

Run `git-publish` inside a Git repository with a clean tracked working tree. It packs the committed source, so commit any edits you want to publish. Gitignored build output that matches the package's `files` field is included.

## Package selection

Without arguments, `git-publish` publishes the package in the current directory. In a workspace, positional arguments select packages by name, directory, or a quoted glob of package directories:

```sh
git-publish @acme/core ./packages/adapter './packages/plugins/*'
```

See [Monorepos](./monorepos.md) for what a selection publishes. `skills` is a subcommand, so select a workspace package named `skills` by its path, such as `./packages/skills`.

## Flags

| Flag | Description |
| --- | --- |
| `-r, --remote <remote>` | Git remote name or URL to push to. Default: `origin` |
| `-b, --branch <template>` | Branch name or template. See [Branches](#branches) |
| `-d, --dry` | Simulate the run. Does not commit or push |
| `-o, --fresh` | Publish a single-commit branch, replacing its history with a force-push. See [`--fresh`](#--fresh) |
| `-f, --force` | Allow publishing a private standalone package or a selected private workspace root, such as `git-publish . --force` |
| `--json <path>` | Write publication details and install sets to a JSON file. See [JSON output](#json-output) |
| `-h, --help` | Show help |
| `--version` | Show the version |

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

- `source.commit` is the full source commit ID, or `null` when the source has no commit.
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
