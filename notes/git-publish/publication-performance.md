# Publication performance

In the workspaces measured below, the git-publish process used little CPU during a workspace publication. Before parallel packing, per-command timings in a private workspace attributed most of the wall time to subprocesses that ran for one package at a time: resetting and cleaning the isolated checkout, the package manager's `pack`, and the package's lifecycle hooks. Its `prepack` hooks built each package, and those builds took most of the time.

Measure changes with [`bench/`](../../bench/README.md), which compares builds in alternating runs.

## Where the time goes

[`publishWorkspaceClosure`](../../src/workspace-publication/publish.ts) starts package tasks in dependency order, up to the smaller of the available CPU count and the package count. Each pack uses a detached checkout from a [pool](../../src/publish-repository/create.ts). The pool creates checkouts on demand, resets and cleans them before each use, and removes them at the end. Only creation is serialized: simultaneous `git worktree add` calls can read one another's incomplete registrations.

Manifests use [branch references](./branch-channel.md), so packing does not need to wait for dependencies. Each task returns its checkout before waiting for the dependency preparations it needs to validate packed versions and import a publication commit. Concurrent imports share the Git object store but write distinct refs and do not use a checkout's index. After all tasks finish, the CLI validates peer ranges and checks that no hook changed the source checkout before it pushes. If a task fails, the group cancels the other tasks and waits for them to stop before disposing of the checkouts.

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

### Parallel packing comparison

Measured on Mon Nov 23 2026 with Node.js 26.13.0, pnpm 12.18.0, and Git 2.54.0 on macOS with 12 available CPUs. The generated workspace used the default 20 packages (no hooks) and three timed runs per build after one warmup. The load average at the start of the final run was 143.9, just after the test suite. An earlier implementation at a load average of 3.8 gave similar synthetic timings (2.10 s to publish and 1.94 s to republish).

```sh
pnpm bench --scenario publish --scenario republish --cli dist/index.js --cli ../base/dist/index.js
```

| Scenario | Sequential (`d872c42`) | Parallel |
| --- | ---: | ---: |
| First publish | 5.09 s (5.03–5.11 s) | 2.17 s (2.17–2.24 s) |
| Unchanged republish | 4.45 s (4.45–4.46 s) | 2.08 s (1.99–2.25 s) |

### Parallel packing with build hooks

On the same machine, a separate private pnpm workspace published fewer than ten packages with build hooks. An isolated clone used pnpm 12.21.0 and prebuilt its libraries once before the measurement. The sequential build also needs those prebuilt files: the hooks resolve internal build dependencies through the source clone's `node_modules`, not through other pack checkouts.

Each configuration ran three times in rotating order. Each run published to a fresh local bare clone and then republished without changes. The bare clones occupied the same path in turn so the rewritten dependency URLs stayed identical. The cap-of-three experiment overrode `os.availableParallelism()` in the benchmark CLI process only.

| Scenario | Sequential (`d872c42`) | Default parallelism | Cap of three |
| --- | ---: | ---: | ---: |
| First publish | 14.29 s (12.41–15.01 s) | 14.48 s (13.58–14.91 s) | 10.67 s (9.93–11.44 s) |
| Unchanged republish | 14.40 s (14.08–14.54 s) | 12.96 s (12.15–15.06 s) | 10.61 s (10.33–10.82 s) |

Every package had the same published Git tree ID in every run, and every republish retained the branch tips. Default parallelism did not improve the first-publish median in this workspace. The cap of three was faster than both alternatives in every round for both scenarios, but this does not establish a general cap for other workloads. The implementation keeps the CPU-based limit.

### Earlier profile of a private workspace with build hooks

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
- Each pack has its own checkout, but lifecycle hooks still share the source checkout's symlinked `node_modules`. Hooks that write to a shared cache or build output must not assume that another package's hook has finished.
