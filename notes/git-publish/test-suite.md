# Test suite isolation

The [test entry point](../../tests/index.ts) gives every process the suite spawns a temporary home, so results do not depend on the developer's machine.

[`isolateEnvironment()`](../../tests/utils/isolate-environment.ts) points `HOME` and the `XDG_*` directories at a temporary directory. It removes inherited `GIT_*`, `npm_*`, `pnpm_*`, `yarn_*`, and `bun_*` variables, `NODE_OPTIONS`, and `NODE_PATH`. `PNPM_HOME` stays because it locates the installed pnpm.

It changes `process.env` itself, because nano-spawn merges its `env` option into `process.env` ([nano-spawn source](https://github.com/sindresorhus/nano-spawn/blob/v2.1.0/source/options.js#L16)), and specs also spawn Git without an `env` option. A per-spawn `env` cannot remove a variable.

The temporary home starts with an empty `.gitconfig`. No test needs registry credentials or a warm package-manager cache: all tests passed with empty npm, pnpm, Yarn, and Bun caches on Tue Nov 24.

Running one spec directly (`node tests/specs/x.ts`) skips the entry point, so it uses the developer's home.
