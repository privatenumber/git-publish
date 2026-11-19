# Signal tests

Run the signal-handling tests before starting the concurrent publication tests. The [test entry point](../../tests/index.ts) awaits the lifecycle spec's import, and the [lifecycle spec](../../tests/specs/lifecycle-hooks.ts) awaits its signal group. In [manten 2.0.0](https://github.com/privatenumber/manten/blob/v2.0.0/README.md#L108-L151), awaiting a group waits for its children. The rest of the suite still runs concurrently.

The tests send signals only after the Git smudge filter or npm prepack hook announces readiness. A watchdog starts at CLI spawn, not during Git fixture setup. An exit before readiness fails with the wait name, elapsed time, exit status, and CLI output. A live CLI that never becomes ready or never finishes after a signal fails at the watchdog. Neither case needs a retry or a longer deadline.

## Evidence

On 2026-11-19, `pnpm install --frozen-lockfile`, `pnpm build`, and `CI=true pnpm test` on [e146a9f](https://github.com/privatenumber/git-publish/tree/e146a9f262d464525144e2229218d1c1a71232f0) reproduced the second-signal timeout on macOS 27.0.1 arm64 with Node.js 26.13.0, pnpm 12.18.0, npm 12.2.2, and Git 2.54.0. Diagnostic changes preserved the 30-second deadline that started [before the pack fixture was set up](https://github.com/privatenumber/git-publish/blob/e146a9f262d464525144e2229218d1c1a71232f0/tests/specs/lifecycle-hooks.ts#L145-L175). One run reported:

```text
[signal diagnostics: second signal] +24963ms spawned CLI
Error: prepack connection failed after 7029ms (31992ms since test start; CLI exit code: null, signal: null):
(no CLI output)
```

All three runs timed out waiting for the prepack connection. The CLI had been running for 7.0, 19.7, and 14.7 seconds when the timer expired. It was alive and the test had not sent either signal. Changing production signal handling could not fix those timeouts.

A follow-up trace kept the original concurrent scheduling and logged the old deadline without aborting the connection wait. It recorded Node startup and subprocess spawn/exit events with a `NODE_OPTIONS=--require` preload in the CLI and its descendants. The isolated test spent 128 ms between timer creation and CLI spawn, then 1,192 ms from spawn to connection. In the loaded run that crossed the deadline, fixture setup used 14,086 ms. After CLI spawn, Git setup and worktree preparation pushed the npm launch to 14,739 ms. The old deadline fired at 16,579 ms, after the npm CLI started but before it spawned the hook shell. The connection arrived at 20,405 ms, and both signals were handled. This isolates the delay to work before the hook handshake, not signal delivery.

The worktree test passed all three runs, so the cause of its [reported CI timeout](https://github.com/privatenumber/git-publish/issues/117) remains unknown. For a controlled early exit, temporarily omit the `origin` remote from that test's fixture and run `TESTONLY='cleans up after SIGTERM during worktree creation' pnpm test`. The diagnostic reported `Waiting for worktree ready marker failed after 369ms (370ms since CLI spawn; exit code: 1, signal: null)` and `Error: Git remote "origin" does not exist`.
