# git-publish

Publish your npm package to a Git branch.
Useful for testing packages in production-like environments before publishing to npm.

<br>

<p align="center">
	<a href="https://github.com/sponsors/privatenumber/sponsorships?tier_id=398771"><img width="412" src="https://raw.githubusercontent.com/privatenumber/sponsors/master/banners/assets/donate.webp"></a>
	<a href="https://github.com/sponsors/privatenumber/sponsorships?tier_id=416984"><img width="412" src="https://raw.githubusercontent.com/privatenumber/sponsors/master/banners/assets/sponsor.webp"></a>
</p>

## Why?

To test a package without publishing to the npm registry.

### Why not use `npm publish`?

Publishing to npm just for testing has major downsides:

- **Versioning overhead:** You must bump the version, even for throwaway builds.
- **Permanent:** npm's [strict unpublish policy](https://docs.npmjs.com/policies/unpublish) makes removing test releases difficult.
- **Hard to inspect:** npm doesn't make it easy to view the contents of a published package.
- **Risky:** You could accidentally publish test code as a stable release.

### Why not use `npm link`?

- Skips [npm lifecycle scripts](https://docs.npmjs.com/cli/v8/using-npm/scripts#life-cycle-scripts)
- Links the entire project (including source, tests, configs)
- Doesn't install dependencies automatically

### So why `git-publish`?

- **No versioning required:** Uses Git branches instead of package versions.
- **Easy cleanup:** Delete the branch when you're done.
- **Browsable:** View and verify the published package on GitHub.
- **Safe:** Keeps test builds out of npm.
- **Realistic simulation:** Runs `prepare` and `prepack`, and includes only publishable files.

## Usage

Publish your npm package to a Git branch:

```sh
npx git-publish
```

This publishes the current package to the branch `npm/<current branch>` on the remote `origin`.

### Global install

```sh
npm install -g git-publish
```

Then run with:

```sh
git-publish
```

### CLI Flags

| Flag                    | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `-b, --branch <name>`   | Target branch name. Defaults to `npm/<current branch or tag>` |
| `-r, --remote <remote>` | Git remote to push to (default: `origin`)                     |
| `-o, --fresh`           | Create a fresh single-commit branch. Force-pushes to remote   |
| `-d, --dry`             | Simulate the process. Does not commit or push                 |
| `-h, --help`            | Show CLI help                                                 |
| `--version`             | Show CLI version                                              |

## FAQ

### What are some use cases?

- Testing a package before it's ready for npm
- Contributing to a repo where you don't have publish access
- Testing in a CI/CD or remote environment where `npm link` doesn't work
- Avoiding symlink issues from `npm link`

### How do I include a build step?

Add your build command to the [`prepack`](https://docs.npmjs.com/cli/v8/using-npm/scripts#prepack) script in `package.json`:

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
2. Runs the `prepare` and `prepack` npm scripts
3. Uses [npm-packlist](https://github.com/npm/npm-packlist) to determine publishable files
4. Commits only those files
5. Pushes the branch to the Git remote
6. Prints the command to install the package via Git

### Why preserve commit history on the publish branch?

When installing from Git, npm uses commit hashes—not branch names. If the commit is "detached" (i.e., unreachable from history), it may be garbage-collected, breaking installs.

To avoid this, `git-publish` preserves history by default.

If you prefer a single clean commit and understand the risks, use the `--fresh` flag to force-push a one-commit branch.

### Why not just commit the files manually?

Manual commits often:

- Miss important files (e.g., those not in `dist/`)
- Include irrelevant files (e.g., tests, source, configs)
- Skip npm lifecycle scripts

`git-publish` avoids these pitfalls by using `npm-packlist` (same as `npm publish`) and running `prepare` and `prepack`.

### Can I use this in a monorepo?

Yes. Run `git-publish` from inside the specific package directory (e.g., `packages/my-lib`).

It will detect and publish only that package's contents to the root of the Git branch.

> [!IMPORTANT]
> Currently does not support resolving `workspace:` protocol dependencies. Avoid using those or pre-bundle them before publishing.

### Can I publish to and install from a private repository?

Yes—if your Git client (e.g., local dev, CI, etc.) is authorized to access the repo.

If that's not possible, you can push the branch to a public repo using the `--remote` flag.

> [!WARNING]
> Minify or obfuscate private code before publishing to a public repo.

#### Example: publishing from private repo A to public repo B

Say you're testing changes in **Repo A**, but your GitHub Actions workflow in **Repo B** can't access private repos. You can push the publish branch to **Repo B** instead:

```sh
npx git-publish --remote git@github.com:repo-b.git --branch test-pkg
```

Result:

```sh
✔ Successfully published branch! Install with command:
  → npm i 'repo-b#test-pkg'
```

## Sponsors

<p align="center">
	<a href="https://github.com/sponsors/privatenumber">
		<img src="https://cdn.jsdelivr.net/gh/privatenumber/sponsors/sponsorkit/sponsors.svg">
	</a>
</p>
