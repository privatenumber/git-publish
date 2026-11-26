# Publication performance

In the workspaces measured below, the git-publish process used little CPU during a workspace publication. Before parallel packing, per-command timings in a private workspace attributed most of the wall time to subprocesses that ran for one package at a time: resetting and cleaning the isolated checkout, the package manager's `pack`, and the package's lifecycle hooks. Its `prepack` hooks built each package, and those builds took most of the time.

Measure changes with [`bench/`](../../bench/README.md), which compares builds in alternating runs.

## Where the time goes

[`publishWorkspaceClosure`](../../src/workspace-publication/publish.ts) starts package tasks in dependency order, up to a concurrency limit described in [Concurrency limit](#concurrency-limit). Each pack uses a detached checkout from a [pool](../../src/publish-repository/create.ts). The pool creates checkouts on demand, resets and cleans them before each use, and removes them at the end. Only creation is serialized: simultaneous `git worktree add` calls can read one another's incomplete registrations.

Manifests use [branch references](./branch-channel.md), so packing does not need to wait for dependencies. Each task returns its checkout before waiting for the dependency preparations it needs to validate packed versions and import a publication commit. Concurrent imports share the Git object store but write distinct refs and do not use a checkout's index. After all tasks finish, the CLI validates peer ranges. For workspace plans, it then checks that the source checkout's HEAD and tracked files did not change before it pushes. This check does not detect changes to ignored or untracked files. If a task fails, the group cancels the other tasks and waits for them to stop before disposing of the checkouts.

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

Measured on Mon Nov 23 2026 with Node.js 26.13.0, pnpm 12.18.0, and Git 2.54.0 on macOS with 12 available CPUs. The generated workspace used the default 20 packages (no hooks) and three timed runs per build after one warmup. The 1-minute load average (`sysctl -n vm.loadavg`) was 3.27 at the start, and no other benchmark or test run was active.

```sh
node bench/index.ts --scenario publish --scenario republish --cli dist/index.js --cli ../base/dist/index.js
```

| Scenario | Sequential (`d872c42`) | Parallel |
| --- | ---: | ---: |
| First publish | 4.76 s (4.70–4.76 s) | 1.97 s (1.96–2.03 s) |
| Unchanged republish | 4.21 s (4.19–4.24 s) | 1.84 s (1.80–1.87 s) |

### Parallel packing with build hooks

On the same machine, a separate private pnpm workspace published fewer than ten packages with build hooks. An isolated clone used pnpm 12.21.0 and prebuilt its libraries once before the measurement. The sequential build also needs those prebuilt files: the hooks resolve internal build dependencies through the source clone's `node_modules`, not through other pack checkouts.

Each configuration ran three times in rotating order. Each run published to a fresh local bare clone and then republished without changes. The bare clones occupied the same path in turn so the rewritten dependency URLs stayed identical. The cap-of-three experiment overrode `os.availableParallelism()` in the benchmark CLI process only.

Before each round, the run waited until the 1-minute load average was 6 or lower. The loads at the start of the three rounds were 4.34, 5.42, and 4.99. No other benchmark or test run was active.

| Scenario | Sequential (`d872c42`) | Earlier default at `93cbf11`, `min(CPUs, packages)` = 7 | Cap of three |
| --- | ---: | ---: | ---: |
| First publish | 12.61 s (11.76–14.14 s) | 12.52 s (11.74–13.46 s) | 9.38 s (9.05–10.03 s) |
| Unchanged republish | 14.20 s (14.20–14.40 s) | 11.81 s (11.75–11.89 s) | 9.91 s (8.83–10.36 s) |

Every package had the same published Git tree ID in every run, and every republish retained the branch tips. The earlier default of 7 did not improve the first-publish median in this workspace. The cap of three was faster than both alternatives in every round for both scenarios.

No single long build bounds the wall time. In a first publish with all seven packages at once, the per-package task times were 2, 2, 6, 7, 8, 9, and 10 s. With a cap of three, the same packages took 1 to 4 s each. Every build slows when seven run together, which suggests that the concurrent build hooks contend for CPU or I/O. The comparison of more caps below chose the limit.

### Concurrency sweep

Measured on Mon Nov 23 2026 on the same machine, an M2 Max with 8 performance cores, 4 efficiency cores, and 64 GB of memory. Both workloads used the same setup as the comparisons above, and the cap was overridden in the benchmark CLI process only. Each run waited until the 1-minute load average was 6 or lower.

Workspace with build hooks: three rotating rounds per cap, with round loads of 3.66, 5.37, and 5.99. Caps 1 and 7 come from the earlier session above, with round loads of 4.34, 5.42, and 4.99, so compare those two rows only roughly.

| Cap | First publish | Unchanged republish |
| ---: | ---: | ---: |
| 1 (sequential, earlier session) | 12.61 s (11.76–14.14 s) | 14.20 s (14.20–14.40 s) |
| 2 | 10.72 s (10.43–11.26 s) | 8.82 s (8.58–8.88 s) |
| 3 | 9.87 s (9.78–10.48 s) | 9.17 s (8.75–9.60 s) |
| 4 | 9.88 s (9.69–11.37 s) | 9.66 s (8.95–9.86 s) |
| 5 | 10.22 s (9.57–11.15 s) | 11.36 s (9.40–11.42 s) |
| 7 (earlier default at `93cbf11`, earlier session) | 12.52 s (11.74–13.46 s) | 11.81 s (11.75–11.89 s) |

Generated workspace without hooks: load average 2.74 at the start. The sequential row comes from the comparison above.

| Cap | First publish | Unchanged republish |
| ---: | ---: | ---: |
| 1 (sequential, earlier run) | 4.76 s | 4.21 s |
| 2 | 2.99 s (2.95–3.04 s) | 2.70 s (2.67–2.73 s) |
| 3 | 2.53 s (2.51–2.60 s) | 2.28 s (2.28–2.35 s) |
| 4 | 2.16 s (2.13–2.18 s) | 1.98 s (1.97–2.05 s) |
| 12 | 2.01 s (1.99–2.04 s) | 1.87 s (1.86–1.90 s) |

Every hook-workspace run produced the same published trees as the sequential build, and every republish retained the branch tips.

### Concurrency limit

Decision: git-publish packs at most `Math.min(Math.max(1, Math.floor(os.availableParallelism() / 3)), packageCount)` packages at once.

- This is a workload-dependent heuristic. Build hooks are often multi-threaded, as the pkgroll (esbuild) hooks measured here are, so one pack can occupy several cores. With those hooks, throughput was flat from 2 to 4 packs and dropped from 5.
- Without hooks, most of the gain arrived by 4 packs.
- On 12 CPUs, the divisor gives 4, the current default on this machine. Machines with 5 CPUs or fewer, such as 4-vCPU CI runners, pack sequentially. The divisor does not prevent oversubscription in general: a hook with more threads than the measured ones can still oversubscribe.

This limit is verified on one 12-CPU machine only. Revisit it if a slower or faster machine shows a different knee.

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

## Remote connections

Over SSH to GitHub, each remote connection costs about 2 s, so git-publish keeps the count low ([`prepare-branch.ts`](../../src/publish-repository/prepare-branch.ts), [`publish.ts`](../../src/workspace-publication/publish.ts)):

1. One `ls-remote` reads the publish branch heads and the [conflicting refs](./branch-channel.md#remote-refs-that-can-conflict). A second lookup runs only in normal mode when the history URL differs from the push URL (see [Remote URLs](./remote-urls.md)).
2. One `fetch --depth=1` runs when a publish branch already exists. `--fresh` skips it.
3. One `push` runs, unless every publication reuses its branch's existing commit. Then the CLI prints that the branch is already up to date and does not push. `--fresh` never reuses a commit, because it does not read history, so it always pushes. It uses `--force-with-lease` with the tip that the lookup observed, and an empty expected value for a branch that did not exist.

Counts traced with a `git` wrapper on `PATH` on Tue Nov 24 2026, before (`59bd484`) and after this change:

| Scenario | Before | After |
| --- | ---: | ---: |
| First publish, standalone or workspace | 3 | 2 |
| Unchanged republish, standalone or workspace | 4 | 2 |
| Changed republish | 4 | 3 |
| `--fresh`, standalone or workspace | 2 | 2 |
| Push URL in another repository (fork), first / unchanged | 3 / 4 | 2 / 2 |
| Same repository, two transports, first / unchanged | 3 / 4 | 3 / 3 |

**Trade-off of the skipped push (maintainer-approved Tue Nov 24 2026).** Before, the push of an unchanged commit failed as a non-fast-forward when another publisher moved the branch between the lookup and the push. Without the push, git-publish does not detect this and reports success, while the branch holds the other publisher's commit. Revisit if concurrent publishers to one branch become a supported workflow.

## Consequences for workspaces

- Before `prepack` runs, git-publish copies the package's files that npm would pack, as listed by `npm-packlist`, from the source checkout into the isolated checkout ([`pack-package.ts`](../../src/utils/pack-package.ts)). These are the `files` list, including existing build output, and entries npm always packs, such as `main` and `bin`. Other untracked files are not copied. When a `prepack` hook rebuilds all of the output that the package publishes, a workspace build before publishing does the same work again. When a hook relies on output that the workspace build created, the workspace build is required.

## Limitations

- Hooks of different packages run at the same time and share the source checkout's symlinked `node_modules`, as scripts run by `pnpm -r run` do. A hook that writes a shared cache non-atomically can race with another package's hook. Workaround: publish those packages in separate runs.
- After one pack fails, git-publish sends SIGTERM to the process groups of the other running packs and waits for them to exit ([`spawn-abortable.ts`](../../src/utils/spawn-abortable.ts)). A hook that ignores SIGTERM keeps the CLI waiting. A second Ctrl-C exits the CLI, and its exit handler sends SIGKILL to the pack groups ([`runWithSignals`](../../src/index.ts)).
