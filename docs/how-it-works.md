# How it works

`git-publish` publishes what `npm publish` would, but to a Git branch:

1. Captures the source commit, checks it out in an isolated repository, and plans publication from that checkout.
2. Reads the publish branch's existing history, unless `--fresh` is used.
3. Packs the package with your package manager (`npm pack`, `pnpm pack`, `yarn pack`, or `bun pm pack`). These commands run `prepack` and `postpack`; npm, pnpm, and Bun also run `prepare`.
4. Removes the `prepare`, `prepack`, and `postpack` scripts and the `workspaces` and `devDependencies` fields from the packed manifest, then commits the packed files. Package managers would otherwise rerun preparation when installing the Git dependency. Install lifecycle scripts remain; `build` is removed only when no install hook remains.
5. Pushes the branch to the Git remote.
6. Prints the command to install the package from Git.

Unchanged packages reuse their existing commit, so republishing an unchanged package pushes nothing new.

## Build steps

Add your build command to the [`prepack`](https://docs.npmjs.com/cli/v11/using-npm/scripts#life-cycle-scripts) script, as you would for `npm publish`:

```json5
{
    // ...

    "scripts": {
        "prepack": "npm run build",
    },
}
```

You can also run the build before `git-publish`. Untracked files, including gitignored build output, are selected to approximate what npm would pack from your working directory. The package manager applies its own pack rules afterward. Tracked files come from the captured commit; lifecycle hooks can change files in the isolated checkout before packing. Clean stale output as part of your build, for example with `pkgroll --clean-dist`. For workspace builds and custom hooks in a fork, see [Preparing packages](./monorepos.md#preparing-packages).

After lifecycle hooks run, `git-publish` checks each positive `files` entry against the packed package. If an entry matches no packed file or directory, it warns and still publishes. That usually means the build did not run or the entry is wrong.

## Commit history

`git-publish` keeps the publish branch's history by default. Lockfiles record the commit of a Git dependency, not the branch name, and a commit that becomes unreachable from the branch history may be garbage-collected, which breaks installs that pinned it. `--fresh` replaces the history with a single commit; see [`--fresh`](./cli.md#--fresh).

## Why not commit the files manually?

Manual commits often miss files outside `dist/`, include irrelevant files such as tests, source, and configs, and skip npm lifecycle scripts. `git-publish` avoids these by packing with your package manager, like `npm publish` does.
