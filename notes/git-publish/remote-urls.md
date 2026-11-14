# Remote URLs

**Decision.** Install URLs, manifest pins, and branch-history lookups name the repository that receives the push. The transport comes from the fetch URL when possible. git-publish does not include credentials in published manifests, `--json`, or the remote URLs it prints. Verified 2026-11-07.

## Push destination identity

A commit-pinned URL is only valid if it names a repository that contains the commit, and after a push only the push destination is guaranteed to. So when a remote fetches from one repository and pushes to another (for example `origin` fetches upstream and `remote.origin.pushurl` points at a fork), git-publish uses the push destination.

- **Same repository, different transports** (HTTPS fetch, SSH push): the fetch URL is used, because it is usually the consumer-friendly transport.
- **Different repositories on the same hosted provider** (github.com, gitlab.com, bitbucket.org): the fetch URL's transport with the push destination's owner and repository, for example fetch `https://github.com/upstream/r.git` plus push `git@github.com:me/r.git` gives `https://github.com/me/r.git`.
- **Otherwise:** the push URL.
- **Several push URLs** (standalone mirrors): the first push URL, unless one of them is the fetch repository.

Repository identity ignores the user in HTTP(S) and `git://` URLs, where the user only selects credentials, and on hosted providers. It keeps the user and the home-relative versus absolute path distinction for SSH and SCP URLs on other hosts (`git@server:repo.git` is relative to the SSH user's home; `git@server:/repo.git` is absolute).

Remote URLs are read as configured (`git config --get-all remote.<name>.url`, `remote.<name>.pushurl`): the fetch URL is the first `url`, and without `pushurl` Git pushes to every `url`. Git applies `url.<base>.insteadOf` at transport time in the isolated clone.

**Known limitation:** an `insteadOf` rule that rewrites an upstream URL to a different repository makes install URLs name the upstream. Transport-only rewrites (`https://github.com/` to `git@github.com:`) keep the same identity and work. Revisit if a user reports the repository-changing case.

Tests: [`tests/specs/remote-transport.ts`](../../tests/specs/remote-transport.ts) ("selects install and history URLs by destination identity", "prints the fork with the fetch transport for a hosted triangular remote", "uses the first fetch URL and all configured URLs for pushes"), [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts) ("publishes and reloads a workspace closure from the push destination").

## Credentials

Install specifiers omit passwords and keep usernames only for SSH. URL and SCP-like remotes with a query or fragment are rejected before packing, including file URLs. Local filesystem paths can contain `?` and `#`; these characters are encoded in the install URL. Errors identify a configured remote by name and never print a rejected URL. Displayed URLs with userinfo, queries, or fragments are redacted, except for strict SSH URLs with a bare username. Helper commands and SCP queries or fragments are also redacted. Tests: [`tests/specs/error.ts`](../../tests/specs/error.ts), [`tests/specs/github-remotes.ts`](../../tests/specs/github-remotes.ts), and [`tests/specs/remote-transport.ts`](../../tests/specs/remote-transport.ts).

Git can introduce credentials through its own configuration, such as an `insteadOf` rewrite to an `ext::` helper. git-publish does not sanitize arbitrary Git trace output, including output enabled by `GIT_TRACE`.

## Install protocols

Install URLs support HTTP, HTTPS, SSH, Git, and file transports. Other transports, including Git's `<transport>::<address>` helper syntax, are rejected before packing. SCP-like remotes and local paths are converted to SSH and file URLs respectively. On POSIX, single-letter `://` schemes are rejected and `x:repo.git` is SCP-like; on Windows, drive-letter paths stay local. [npm-package-arg 13.0.2](https://github.com/npm/npm-package-arg/blob/v13.0.2/lib/npa.js#L398-L426) also accepts rsync and FTP, but Git 2.54.0 (Apple Git-157) reports `fatal: git-over-rsync is no longer supported` for `git ls-remote rsync://example.test/repo.git`; FTP is deprecated and fetch-only. The fetch URL and every push URL are validated before destination selection, which can otherwise encode a query into a rewritten path or leave an unsafe push URL available to Git.

Every URL of the selected remote must use a supported install transport, including push-only mirrors. Use a separate remote for a mirror that requires a helper transport. URL and SCP-like remotes containing whitespace, and SCP-like remotes with bracketed IPv6 hosts, are rejected. Local filesystem paths can contain whitespace.

## npm ignores commit pins for non-hosted Git URLs

npm treats a commit-pinned Git dependency as satisfied by any commit of the same URL when the host is not one it recognizes. In [`dep-valid.js` at v12.2.2](https://github.com/npm/cli/blob/v12.2.2/workspaces/arborist/lib/dep-valid.js#L98-L115), the committish is compared only on the hosted branch; for other hosts it compares `fetchSpec`, which excludes the commit:

```text
if (!resHost) {
  if (resRepo.fetchSpec !== requested.fetchSpec) {
    return false
  }
}
```

With npm 12.2.2, a root dependency on `core` at commit A (`1.0.0`) and a dependency `b` that pins `core` at commit B (`2.0.0`), both as `git+file:` URLs, installs successfully, and `b` resolves the root's copy:

```text
app@ /private/tmp/work/app
├─┬ b@1.0.0 (git+file:///tmp/work/b#90820d10931f087d620a8807646b33b8dbfd838b)
│ └── core@1.0.0 deduped
└── core@1.0.0 (git+file:///tmp/work/core#32abc94467ac5f33574461b2288b24d8136b408c)
```

Reported as [npm/cli#10249](https://github.com/npm/cli/issues/10249), which contains the full reproducer. Within one install set every package appears at one commit, so a set is unaffected; mixing sets from different publications can keep the wrong commit. git-publish therefore warns when a multi-package install set uses a remote that is not on GitHub, GitLab, or Bitbucket. GitHub URLs are compared with their commit and behave correctly.
