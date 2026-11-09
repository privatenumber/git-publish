# git-publish

Publish your npm package to a Git branch, then install it anywhere with one command. Test unreleased changes in a real project without publishing to npm.

<br>

<p align="center">
	<a href="https://github.com/sponsors/privatenumber/sponsorships?tier_id=398771"><img width="412" src="https://raw.githubusercontent.com/privatenumber/sponsors/master/banners/assets/donate.webp"></a>
	<a href="https://github.com/sponsors/privatenumber/sponsorships?tier_id=416984"><img width="412" src="https://raw.githubusercontent.com/privatenumber/sponsors/master/banners/assets/sponsor.webp"></a>
</p>

## Quick start

In your package's repository:

```sh
npx git-publish
```

`git-publish` packs the package like `npm publish` does, commits the packed files to the branch `npm/<current branch>`, pushes it, and prints the install command:

```sh
npm i 'owner/repo#npm/main'
```

Run that command in any project that should use the package. To skip `npx`, install `git-publish` globally with `npm install -g git-publish`.

## What you can do

**Try a fix in your app before it's released.** Publish your branch, install it in the app, and iterate. Publishing again adds a commit to the same branch.

**Share a fork's changes** when you don't have publish access to the package:

```sh
npx git-publish --remote fork
```

**Publish a monorepo package with its workspace dependencies.** `git-publish` publishes the workspace packages it needs too, and prints one command that installs them together:

```sh
cd packages/app
npx git-publish
```

**Publish a whole monorepo** by running `git-publish` at the workspace root, or select packages by name, path, or glob:

```sh
npx git-publish @acme/core './packages/plugins/*'
```

**Post previews from CI.** `--json result.json` writes every published branch, commit, and install specifier, for example to comment on a pull request.

**Install from private repositories.** Installs work wherever Git can access the repository, such as a machine set up with `gh auth setup-git`.

## Why not `npm publish` or `npm link`?

- **`npm publish`** needs a version bump for every throwaway build, can't easily be undone under npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish), and risks shipping test code as a release.
- **`npm link`** skips [lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts#life-cycle-scripts), links the whole project instead of the publishable files, doesn't install dependencies, causes symlink issues, and doesn't work in CI or remote environments.
- **`git-publish`** publishes exactly what `npm publish` would, with no versioning, to a branch you can browse on GitHub and delete when you're done.

## Agent skill

`git-publish` ships an [agent skill](https://agentskills.io) that teaches coding agents to publish with git-publish and install published packages. In a project that depends on git-publish, [pnpm agent skills](https://pnpm.io/agent-skills) can link it after approval. With `npx`, `pnpm dlx`, or a global install, use the `skills` command:

```sh
npx git-publish skills --install ~/.agents/skills
```

## Documentation

- [CLI](./docs/cli.md): flags, branch names and templates, `--fresh`, JSON output, and the `skills` command.
- [Monorepos](./docs/monorepos.md): which packages a selection publishes, how internal dependencies are resolved, and how to prepare packages.
- [Installing](./docs/installing.md): install commands, package manager settings, updating, and private repositories.
- [How it works](./docs/how-it-works.md): what `git-publish` changes in the published package, build steps, and commit history.

## Sponsors

<p align="center">
	<a href="https://github.com/sponsors/privatenumber">
		<img src="https://cdn.jsdelivr.net/gh/privatenumber/sponsors/sponsorkit/sponsors.svg">
	</a>
</p>
