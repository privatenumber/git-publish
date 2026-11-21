# Publication performance

In the workspaces measured below, the git-publish process used little CPU during a workspace publication. In the private workspace, per-command timings attributed most of the wall time to subprocesses that run for one package at a time: resetting and cleaning the isolated checkout, the package manager's `pack`, and the package's lifecycle hooks. Its `prepack` hooks built each package, and those builds took most of the time.

Measure changes with [`bench/`](../../bench/README.md), which compares builds in alternating runs.

## Where the time goes

[`publishWorkspaceClosure`](../../src/workspace-publication/publish.ts) processes packages with `concurrency: 1`. All packages share one pack checkout, and each package's publication commit uses the commits of the dependencies prepared before it. For each package, it resets and cleans the checkout, copies the package's untracked files, runs the package manager's `pack` with hooks, and imports the tarball into a commit.

### Generated workspace

The `bench/` script added with this note, with Node.js 26.13.0, pnpm 12.21.0, and Git 2.54.0 on a 12-CPU Mac, on Sat Nov 21 2026. The packages have no hooks. Command and output with the CLI path shortened, at a load average of 12.5:

```text
$ node bench/index.ts --packages 12 --runs 3 --scenario publish --scenario republish
publish: First publish of every package to an empty remote
    4.48s median (4.42s to 4.71s)  CLI CPU 0.96s  0.37s per package  dist/index.js
republish: Publish every package again with no changes
    3.97s median (3.58s to 4.12s)  CLI CPU 0.83s  0.33s per package  dist/index.js
```

The CLI process used under a quarter of the wall time as CPU. CPU time alone does not show where the rest of the time went, or whether the CLI's control flow serializes it.

### Private workspace with build hooks

Observed on the same machine and versions, at commit `39f7950`. The workspace is a private pnpm workspace of about 40 packages, so its source and raw output are not reproduced here. Each package's `prepack` hook builds the package and then rewrites its manifest. The command published every public package to a local bare repository:

```sh
node dist/index.js --remote file:///tmp/remote.git
```

| Run | Wall time |
| --- | --- |
| `prepack` builds each package | 64 s and 70 s |
| Same, with the build removed from `prepack` and prebuilt output | 22 s and 29 s |

- Running the CLI with `node --cpu-prof` recorded about 1.4 s of JavaScript samples and 62 s idle in the CLI process.
- Wrapper scripts named `git` and `pnpm`, placed first on `PATH`, logged each call's start and end time before running the real command. They recorded about 96 s in `pnpm pack` calls, 74 s of it in the build that the hooks ran, and about 10 s in the checkout's reset and clean calls. The wrappers add startup time to each call, so their totals exceed the unwrapped wall time.
- The machine's load average was between 17 and 65 from other processes, and the same publication took 109 s in an earlier run. Treat the absolute numbers as approximate. The ratio between the two rows held in both pairs of runs.

These private observations are an evidence gap for readers without access to the workspace. The generated workspace above is the reproducible evidence; it confirms that the CLI's own CPU time is small, but not how the rest of the time divides between the CLI's control flow, Git, the package manager, and build hooks.

## Republishing unchanged packages

A republish with no changes costs almost as much as a first publish. git-publish compares the tree it imports from the packed tarball with the existing branch tip ([`prepare.ts`](../../src/package-publication/prepare.ts)), so it must pack every package, including running its hooks, before it knows the package is unchanged.

## Consequences for workspaces

- Before `prepack` runs, git-publish copies the package's files that npm would pack, as listed by `npm-packlist`, from the source checkout into the isolated checkout ([`pack-package.ts`](../../src/utils/pack-package.ts)). These are the `files` list, including existing build output, and entries npm always packs, such as `main` and `bin`. Other untracked files are not copied. When a `prepack` hook rebuilds all of the output that the package publishes, a workspace build before publishing does the same work again. When a hook relies on output that the workspace build created, the workspace build is required.
- Packing in parallel is not implemented. It would need one isolated checkout for each concurrent package, and lifecycle hooks would run at the same time against the shared, symlinked `node_modules`. Commit preparation would still run in dependency order after packing. No measurement exists yet for this design.
