# Benchmarks

`bench/index.ts` times the built CLI on a generated workspace and pushes to local bare repositories, so it needs no network. Its child processes inherit only `PATH` from your environment and use a temporary home directory with an empty Git configuration, so your Git, npm, and pnpm settings do not change the results. It needs the Node.js version in `.nvmrc`.

```sh
pnpm bench
pnpm bench --packages 40 --runs 5 --package-manager npm
```

`pnpm bench` builds `dist/` first. To skip the build, run `node bench/index.ts` instead.

## Workspace

The generated workspace has one library per six packages and apps that depend on one or two libraries, through `workspace:*` with pnpm or a plain version range with npm. Each package publishes 20 files from a gitignored `dist/` directory, so every publication run copies untracked build output, as a real build would. Packages have no lifecycle hooks, so the timings measure git-publish and the package manager's `pack`, not a build.

## Scenarios

| Scenario | Runs |
| --- | --- |
| `plan` | `--dry` at the root: workspace discovery and the publication plan |
| `publish` | A first publish of every package to an empty remote |
| `republish` | A publish of every package with no changes. The bench fails if any package gets a new commit |
| `select` | A publish of one app and its libraries to an empty remote |

Select scenarios with `--scenario`, which can repeat. Only `republish` needs an initial publication, which runs before timing starts.

## Reading the results

Each scenario prints the median, minimum, and maximum wall time after one warmup run, and the median CPU time of the CLI process across its threads. CPU time excludes child processes such as Git and the package manager. CPU time does not show where the rest of the wall time goes; that needs a profile or per-command timings.

Every run checks its result. `plan` must print exactly the expected packages, and the publication scenarios check the CLI's `--json` result: exactly the expected packages, with new commits, or with reused commits for `republish`.

`--json <path>` writes the results with the Node.js version, platform, CPU count, and load average.

## Comparing builds

Pass `--cli` more than once to compare builds. Each round runs every build once, in an order that rotates between rounds, so changes in machine load spread across the builds instead of always hitting one:

```sh
pnpm bench --scenario publish --cli dist/index.js --cli ../base/dist/index.js
```

Each `--cli` path must be a `dist/index.js` in a checkout with its own installed dependencies, because the build imports packages from `node_modules`. To build another commit:

```sh
mkdir ../base
git archive <commit> | tar -x -C ../base
(cd ../base && pnpm install && pnpm build)
```

Absolute timings vary with machine load. Compare builds in one run rather than against numbers from another session.
