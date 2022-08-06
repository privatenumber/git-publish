# git-publish

Publish your npm package to a Git branch.

<sub>Support this project by ⭐️ starring and sharing it. [Follow me](https://github.com/privatenumber) to see what other cool projects I'm working on! ❤️</sub>

## Why?

For testing published packages without publishing to npm.

Making a prerelease to npm using `npm publish` has the following drawbacks:

- Needs a unique version for every release.

- Hard to remove due to npm's [strict unpublish policy](https://docs.npmjs.com/policies/unpublish).

- Cumbersome to verify the contents of the published package.

- Production environment—risky if you make a mistake (eg. accidentally publish as stable).

Using `npm link` has the drawback of not running [npm life cycle scripts](https://docs.npmjs.com/cli/v8/using-npm/scripts#life-cycle-scripts) and including non-publishable assets.


In contrast, `git-publish` has the following benefits:

- **Unversioned** Instead of versions, branch names are used. Branches can be updated to reflect latest change.

- **Deletable** Simply delete the branch when you're done with it.

- **Browsable** Use GitHub to verify the contents of the branch. You can even share a link for others to see.

- **Dev environment** Low risk of mistakes.

- **Simulates `npm publish`** Runs npm life cycle scripts and only includes publishable assets.

## Usage

Publish your npm package to a branch on the Git repository:

```sh
npx git-publish
```

> **⚠️ Warning:** This command will force-push to the remote branch `npm/<current branch>`. Make sure there are no unsaved changes there.


### Global install
Keep the command handy by installing it globally:

```sh
npm install -g git-publish
```

When globally installed, you can use it without `npx`:
```sh
git-publish
```

### Flags
| Flag | Description |
| - | - |
| `-b, --branch <branch name>` | The branch to publish the package to. Defaults to prefixing "npm/" to the current branch or tag name. |
| `-r, --remote <remote>` | The remote to push to. (default: `origin`) |
| `-d, --dry` | Dry run mode. Will not commit or push to the remote. |
| `-h, --help` | Show help |
| `--version` | Show version |

## FAQ

### What are some use-cases where this is useful?
- When you want to test a new package that isn't ready to be published on npm.

- When you're contributing to an open source project so you don't have publish access, but want to test the changes in a production-like environment.

- When you want to test in a remote environment so you can't use `npm link`.

- When you want to avoid using `npm link` because of symlink complexities.


### How can I include a build step?

Call the build command it in the [`prepack` script](https://docs.npmjs.com/cli/v8/using-npm/scripts#:~:text=on%20npm%20publish.-,prepack,-Runs%20BEFORE%20a).

### What does this script do?

1. Run [npm  hooks](https://docs.npmjs.com/cli/v8/using-npm/scripts) `prepare` & `prepack`
2. Create a temporary branch by prefixing the current branch with the `npm/` namespace
3. Detect and commit the [npm publish files](https://github.com/npm/npm-packlist)
4. Force push the branch to remote
5. Delete local branch from Step 2
6. Print the installation command for the branch

### How is this different from simply committing the files to a branch?

- There can be missing distribution files (eg. files outside of `dist`). _git-publish_ uses [npm-packlist](https://github.com/npm/npm-packlist) —the same library `npm publish` uses—to detect publish files declared via `package.json#files` and `.npmignore`.
- Irrelevant files are committed (eg. source files). This can slow down installation or even interfere with the library behavior. For example, if your project has development configuration files, they can accidentally be read by the dependent tooling.

- npm hooks are not executed. _git-publish_ simulates package packing and runs hooks `prepare` and `prepack`.

### Can I publish to and install from a private repository?

Yes, if using a Git client authorized to access the private repository.

If it must be publicly accessible, you can set the `--remote <remote>` flag to push the publish assets to a public repository. It's recommended to compile and minify the code if doing this with private code.


#### User story
You want to test a branch on a private repository _Repo A_, but GitHub Actions on the consuming project _Repo B_ doesn't have access to the private repository so `npm install` fails.

To work around this, you can publish the branch to _Repo B_ to install it from there:

```sh
$ npx git-publish --remote git@github.com:repo-b.git --branch test-pkg

✔ Successfully published branch! Install with command:
  → npm i 'repo-b#test-pkg'
```
