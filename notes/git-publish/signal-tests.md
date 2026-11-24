# Signal tests

Run the signal-handling tests before starting the concurrent publication tests. The [test entry point](../../tests/index.ts) awaits the import of the [signal spec](../../tests/specs/signals.ts), and the signal spec awaits its `Signals` group. In [manten 2.0.0](https://github.com/privatenumber/manten/blob/v2.0.0/README.md#L108-L151), awaiting a group waits for its children. The rest of the suite still runs concurrently.

The tests send signals only after the Git smudge filter or npm prepack hook announces readiness. A watchdog starts at CLI spawn, not during Git fixture setup. An exit before readiness fails with the wait name, elapsed time, exit status, and CLI output. A live CLI that never becomes ready or never finishes after a signal fails at the watchdog. Neither case needs a retry or a longer deadline.

## Evidence

On 2026-11-19, `pnpm install --frozen-lockfile`, `pnpm build`, and `CI=true pnpm test` on [e146a9f](https://github.com/privatenumber/git-publish/tree/e146a9f262d464525144e2229218d1c1a71232f0) reproduced the second-signal timeout on macOS 27.0.1 arm64 with Node.js 26.13.0, pnpm 12.18.0, npm 12.2.2, and Git 2.54.0. Diagnostic changes preserved the 30-second deadline that started [before the pack fixture was set up](https://github.com/privatenumber/git-publish/blob/e146a9f262d464525144e2229218d1c1a71232f0/tests/specs/lifecycle-hooks.ts#L145-L175). One run reported:

```text
[signal diagnostics: second signal] +24963ms spawned CLI
Error: prepack connection failed after 7029ms (31992ms since test start; CLI exit code: null, signal: null):
(no CLI output)
```

All three runs timed out waiting for the prepack connection. The CLI had been running for 7.0, 19.7, and 14.7 seconds when the timer expired. It was alive and the test had not sent either signal. Changing production signal handling could not fix those timeouts.

A follow-up trace with the original scheduling showed the same pattern: the old deadline fired after the npm CLI started but before it spawned the prepack hook. The connection arrived about 4 s later, and the CLI then handled both signals.

The worktree test passed all three runs, so the cause of its [reported CI timeout](https://github.com/privatenumber/git-publish/issues/117) remains unknown. For a controlled early exit, temporarily omit the `origin` remote from that test's fixture and run `TESTONLY='cleans up after SIGTERM during worktree creation' pnpm test`. The diagnostic reported `Waiting for worktree ready marker failed after 369ms (370ms since CLI spawn; exit code: 1, signal: null)` and `Error: Git remote "origin" does not exist`.
