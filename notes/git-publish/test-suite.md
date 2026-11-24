# Test suite isolation and concurrency

The test entry point gives every spawned process a temporary home and runs a bounded number of tests at a time. Both choices keep results independent of the developer's machine and of the load the suite creates.

## Temporary home

[`isolateEnvironment()`](../../tests/utils/isolate-environment.ts) runs once in the [test entry point](../../tests/index.ts). It points `HOME` and the `XDG_*` directories at a temporary directory, and it removes inherited `GIT_*`, `npm_*`, `pnpm_*`, `yarn_*`, and `bun_*` variables, `NODE_OPTIONS`, and `NODE_PATH`. `PNPM_HOME` stays because it locates the installed pnpm.

The change is made to `process.env` because nano-spawn merges its `env` option into `process.env` ([nano-spawn source](https://github.com/sindresorhus/nano-spawn/blob/v2.1.0/source/options.js#L16)), and specs also spawn Git without an `env` option. Before this change, the CLI under test copied the developer's global Git configuration, including signing and credential helper settings, into its temporary repositories.

The temporary home starts with an empty `.gitconfig`. No test needed registry credentials or a warm package-manager cache: all 387 tests passed with empty npm, pnpm, Yarn, and Bun caches on Tue Nov 24.

## Bounded concurrency

The entry point runs two spec files at a time, and each spec group runs `ceil(os.availableParallelism() / 2)` tests at a time ([`test-concurrency.ts`](../../tests/utils/test-concurrency.ts)). Most tests drive one subprocess chain at a time, so the product keeps about one test on each CPU.

Spec files `await` their groups, so the entry point's `await import()` settles when a spec's tests finish. Groups that contain groups (`package-managers.ts` and `package-contents.ts`) also `await` the inner groups.

### Why the root group has no `parallel` option

In manten 2.0.2, a limited group can finish while a child group still waits for a slot. `test()` records its promise in the parent before it waits for the limiter ([create-test.ts](https://github.com/privatenumber/manten/blob/v2.0.2/src/create-test.ts#L207-L221)). `describe()` waits for the limiter first ([context.ts](https://github.com/privatenumber/manten/blob/v2.0.2/src/context.ts#L131-L160)) and records its promise only when it starts ([context.ts](https://github.com/privatenumber/manten/blob/v2.0.2/src/context.ts#L96-L100)). A first attempt with `{ parallel: 2 }` on the root group ran the root `onFinish` cleanup before the last spec files started. Child groups that start after their parent finishes also receive an aborted `signal`. A fixed manten release would let the entry point use `{ parallel: 2 }` instead of its own queue.

### Measurements

Measured on Tue Nov 24 on macOS 27.0.1 arm64 (12 CPUs) with Node.js 26.13.0 and Git 2.54.0. Other work loaded the machine throughout, so wall time is noisy. Runs alternated between the old and new suite:

| Suite | Wall (s) | CPU, user + sys (s) | Slowest test (s) |
| --- | --- | --- | --- |
| Unbounded, inherited home | 66.8, 68.0, 66.1 | 508, 516, 509 | 58.1, 58.4, 57.4 |
| Bounded, temporary home | 64.1, 63.6, 63.5 | 486, 488, 485 | 14.4, 14.9, 14.5 |

Wall time barely changes because the suite is CPU-bound either way. The bound removes the oversubscription that made single tests take about 60 seconds, which caused load-dependent timeouts in the [signal tests](./signal-tests.md). With the earlier root-limiter attempt, other splits of 12 slots (one spec file with 12 tests, three with four) measured within the noise of this split.
