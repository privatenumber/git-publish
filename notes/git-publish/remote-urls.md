# Remote URLs

**Decision.** Install URLs, manifest pins, and branch-history lookups name the repository that receives the push. The transport comes from the fetch URL when possible. git-publish does not include credentials in published manifests, `--json`, or the remote URLs it prints. Verified 2026-11-07.

## Push destination identity

A commit-pinned URL is only valid if it names a repository that contains the commit, and after a push only the push destination is guaranteed to. So when a remote fetches from one repository and pushes to another (for example `origin` fetches upstream and `remote.origin.pushurl` points at a fork), git-publish uses the push destination.

- **Same repository, different transports** (HTTPS fetch, SSH push): the fetch URL is used, because it is usually the consumer-friendly transport.
- **Different repositories on the same hosted provider** (github.com, gitlab.com, bitbucket.org): the fetch URL's transport with the push destination's owner and repository, for example fetch `https://github.com/upstream/r.git` plus push `git@github.com:me/r.git` gives `https://github.com/me/r.git`.
- **Otherwise:** the push URL.

Repository identity ignores the user in HTTP(S) and `git://` URLs, where the user only selects credentials, and on hosted providers. It keeps the user and the home-relative versus absolute path distinction for SSH and SCP URLs on other hosts (`git@server:repo.git` is relative to the SSH user's home; `git@server:/repo.git` is absolute).

Git-publish detects configured remotes with `git remote get-url --push --all -- <name>`, which also finds push-only remotes and validates the configuration. An unknown name is treated as a URL unless it is the default remote. Remote URLs are read as configured (`git config --get-all remote.<name>.url`, `remote.<name>.pushurl`). Git rejects valueless `url` or `pushurl` keys. An explicitly empty entry resets its list, so only entries after the last empty value are used. An empty push list falls back to the URL list; a missing or empty URL list is rejected rather than treating the remote name as a URL. The fetch URL is the first remaining `url`. Without a push list, Git normally pushes to every remaining `url`, but `pushInsteadOf` can select a different push URL. Git applies `url.<base>.insteadOf` at transport time in the isolated clone.

An explicit `pushurl` stays a `pushurl` in the isolated clone. Git applies `insteadOf`, but not `pushInsteadOf`, to it. With Git 2.54.0 (Apple Git-157), `git remote get-url --push -- origin` returned the `insteadOf` destination for an explicit `pushurl` and the `pushInsteadOf` destination for the same value set as `url`. This matches [Git's rewrite implementation](https://github.com/git/git/blob/v2.54.0/remote.c#L587-L615).

**Known limitation:** an `insteadOf` rule that rewrites an upstream URL to a different repository makes install URLs name the upstream. Transport-only rewrites (`https://github.com/` to `git@github.com:`) keep the same identity and work. Revisit if a user reports the repository-changing case.

Tests: [`tests/specs/remote-transport.ts`](../../tests/specs/remote-transport.ts) ("selects install and history URLs by destination identity", "prints the fork with the fetch transport for a hosted triangular remote", "rejects multiple url destinations before packing", "rejects multiple pushurl destinations before packing"), [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts) ("publishes and reloads a workspace closure from the push destination").

## Never push to the source repository

An empty `--remote` is rejected before inspecting the repository or packing. Immediately before pushing, git-publish asks Git for the isolated clone's effective push destination, after rewrites. For local paths and file URLs, it follows [Git's repository lookup order](https://github.com/git/git/blob/v2.54.0/setup.c#L1757-L1817), including the `.git` suffix fallback, and refuses a destination with the same common Git directory as the source. This covers symlinks and linked worktrees. The error does not print the destination URL. Network transports (`git://`, SSH, HTTP and HTTPS) that serve the source repository are not detected. See the [remote transport tests](../../tests/specs/remote-transport.ts).

The isolated push can differ from `git push` in the source repository in these configurations:

- A relative `insteadOf` replacement such as `../mirror.git` resolves against the isolated clone, not the source worktree.
- With chained `pushInsteadOf` rules `A → B` and `B → C`, Git pushes to `B` from the source, but git-publish pushes to `C` because the clone rewrites `B` again.
- A relative explicit `pushurl` such as `../mirror.git` is made absolute before rewriting, so an `insteadOf` rule that matches the relative value no longer matches.
- A local path such as `~/mirror.git` in a remote's `url` or explicit `pushurl` resolves against the source repository instead of the home directory.

The guard checks the final destination to catch local misconfiguration, not deliberately crafted destinations. It does not cover paths containing control characters or non-UTF-8 bytes, or destinations that change between the check and the push. It checks the destination configured when git-publish pushes; it does not constrain lifecycle scripts, which can run Git themselves. A visible CR or LF in a local destination is reported as unverifiable, including percent-encoded CR or LF in file URLs.

## Decision: require one push URL for every publication

**Maintainer-approved 2026-11-15.** Reject a configured remote with multiple push URLs before packing, including multiple `url` values when no `pushurl` is set. The error never prints destination URLs. It names the remote only when the name matches `[\w.-]+`, and otherwise says "Selected remote", because a remote name could contain credentials. It suggests separate remotes or `--remote <url>`.

**Known limitation:** the check counts configured `url` and `pushurl` entries after resets, not the push URLs Git resolves. It rejects the rare case where several `url` entries are reduced to one push URL by `pushInsteadOf`. Before this decision, multi-package publications counted raw entries without applying resets. Revisit if a user reports this case.

Multiple push URLs were never documented in a release. [`docs/monorepos.md`](https://github.com/privatenumber/git-publish/blob/5a0d0e7/docs/monorepos.md#L35), added in [#85](https://github.com/privatenumber/git-publish/pull/85) on unreleased `develop`, said a single package could push to several destinations. Through [v2.4.3](https://github.com/privatenumber/git-publish/blob/v2.4.3/src/index.ts#L255-L270), git-publish ran `git push <remote>` from a worktree, and Git itself pushed to every push URL. v2.5.0 moved pushing to an isolated clone; [#63 kept the behavior](https://github.com/privatenumber/git-publish/pull/63) by pushing to each URL in turn. Standalone and single-package workspace publications no longer mirror to multiple destinations in one invocation, and the partial-outcome report for a failed mirror push is removed. Separate invocations can target each destination, but do not guarantee identical publication commits or atomicity across destinations. Multi-package workspace publications already rejected multiple destinations.

The push strategy still distinguishes normal pushes, standalone force pushes, and workspace force-with-lease pushes. Remote resolution establishes one destination for the rest of the publication.

## Credentials

Install specifiers omit passwords and keep usernames only for SSH. The display redactor hides userinfo, queries, and fragments in scheme URLs, except that an SSH URL with only a bare username can be displayed unchanged. It also redacts helper commands in displayed URLs when the helper syntax starts the text or follows whitespace, and redacts queries or fragments in SCP-like URLs with a username at the same boundaries.

Validation rejects scheme URLs (including file URLs) and SCP-like URLs with a query or fragment before packing or dry-run output. Local filesystem paths can contain `?` and `#`; these characters are encoded in the install URL.

Validation errors do not print rejected URLs as destination values. An unsupported-transport error does quote a configured remote's name without filtering it, even if the name equals the rejected URL. A helper-shaped name such as `ext::token=example` is printed unchanged because the opening quote prevents the helper redactor from matching. By contrast, the multiple-URL error names the remote only if its name matches `[\w.-]+`; otherwise it says "Selected remote". Tests: [`tests/specs/error.ts`](../../tests/specs/error.ts), [`tests/specs/github-remotes.ts`](../../tests/specs/github-remotes.ts), and [`tests/specs/remote-transport.ts`](../../tests/specs/remote-transport.ts).

Git can introduce credentials through its own configuration, such as an `insteadOf` rewrite to an `ext::` helper. git-publish does not sanitize arbitrary Git trace output, including output enabled by `GIT_TRACE`.

## Install protocols

Install URLs support HTTP, HTTPS, SSH, Git, and file transports. Other transports, including Git's `<transport>::<address>` helper syntax, are rejected before packing. SCP-like remotes and local paths are converted to SSH and file URLs respectively. On POSIX, single-letter `://` schemes are rejected and `x:repo.git` is SCP-like; on Windows, drive-letter paths stay local. [npm-package-arg 13.0.2](https://github.com/npm/npm-package-arg/blob/v13.0.2/lib/npa.js#L398-L426) also accepts rsync and FTP, but Git 2.54.0 (Apple Git-157) reports `fatal: git-over-rsync is no longer supported` for `git ls-remote rsync://example.test/repo.git`; FTP is deprecated and fetch-only. After rejecting multiple push URLs, the fetch URL and the single push URL are validated before destination selection, which can otherwise encode a query into a rewritten path or leave an unsafe push URL available to Git.

The fetch URL and push URL must use a supported install transport. URL and SCP-like remotes containing whitespace, and SCP-like remotes with bracketed IPv6 hosts, are rejected. Local filesystem paths can contain whitespace.

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
