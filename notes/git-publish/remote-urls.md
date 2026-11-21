# Remote URLs

**Decision.** Install URLs and manifest branch references are derived from the selected push URL. The transport comes from the fetch URL when possible. git-publish does not include passwords in published manifests, `--json`, or install commands.

## Push destination identity

When the configured fetch URL points upstream and `pushInsteadOf` selects a fork, git-publish derives the branch URL from the fork. Ordinary `insteadOf` rules can map a consumer-facing alias to a different transport address without changing the printed alias.

- **Same repository, different transports** (HTTPS fetch, SSH push): the fetch URL is used, because it is usually the consumer-friendly transport.
- **Different repositories on the same hosted provider** (github.com, gitlab.com, bitbucket.org): the fetch URL's transport with the push destination's owner and repository, for example fetch `https://github.com/upstream/r.git` plus push `git@github.com:me/r.git` gives `https://github.com/me/r.git`.
- **Otherwise:** the push URL.

Repository identity ignores the user in HTTP(S) and `git://` URLs, where the user only selects credentials, and on hosted providers. It keeps the user and the home-relative versus absolute path distinction for SSH and SCP URLs on other hosts (`git@server:repo.git` is relative to the SSH user's home; `git@server:/repo.git` is absolute). Only the three hosted providers treat `/remote` and `/remote.git` as the same path. A generic SSH host can serve different repositories at those paths.

Git-publish detects configured remotes with `git remote get-url --push -- <name>`, which also finds push-only remotes and validates the configuration. An unknown name is treated as a URL unless it is the default remote. Git rejects valueless `url` or `pushurl` keys. An explicitly empty entry resets its list, so only entries after the last empty value are used. An empty push list falls back to the URL list; a missing or empty URL list is rejected rather than treating the remote name as a URL. Transport uses the effective fetch and push URLs from `git remote get-url`. Install URL selection uses the first configured `url` and either the explicit `pushurl` or, when the effective fetch and push URLs differ, the effective push URL. Resolution happens in the source repository before relative paths are made absolute.

A literal `--remote <url>` uses `git ls-remote --get-url` to resolve `insteadOf` without contacting the remote. For the push URL it prefers a matching `pushInsteadOf` rule, as [Git does for unnamed remotes](https://github.com/git/git/blob/v2.54.0/remote.c#L82-L105). If the winning rule produces an empty URL, the push uses the effective fetch URL, not a shorter push rewrite or the source checkout. Git already drops empty push aliases for named remotes. git-publish rejects empty effective transport URLs, including when an ordinary `insteadOf` rule rewrites an explicit `pushurl` to empty. The literal lookup reads rules with `git config --null` to preserve newlines in values and uses the [longest matching prefix](https://github.com/git/git/blob/v2.54.0/remote.c#L48-L72), keeping the first match on ties after grouping by rewrite base. On Git 2.54.0, `git remote get-url` requires a repository-configured remote, and the line-based `git remote -v` cannot unambiguously delimit multiline URLs.

The isolated transport client does not apply URL rewrites. It uses filtered copies of the source's system and global config and removes rewrite rules from inherited command-scope config. Repository-local and worktree rewrite rules go in the pack worktree's [own `config.worktree`](https://github.com/git/git/blob/v2.54.0/Documentation/git-worktree.adoc#L326-L358), not the shared config. Pack hooks run inside that worktree and inherit the publisher's original system, global, and command config. The generated clone is non-bare and does not copy `core.bare` or `core.worktree` from the source. Git 2.54.0 verified the scope boundary with `git ls-remote --get-url`: a rule written with `git config --worktree` affects the pack worktree but not the main publish checkout.

With `upstream.git` rewritten to `fork.git` by `pushInsteadOf` and `fork.git` rewritten to `other.git` by `insteadOf`, native `git push` and git-publish both push to `fork.git` for named and literal remotes. A consumer with its own URL rewrites can still resolve the printed URL elsewhere.

The [selector-conflict check](./branch-channel.md#remote-refs-that-can-conflict) uses the same remote name and isolated Git client as the branch push. History and conflict lookups share one `ls-remote` when their resolved URLs match, including with an explicit source `pushurl`. If the URLs differ, history uses a separate `ls-remote --branches` lookup. Git-publish passes `--no-follow-tags` so a reachable local annotated tag cannot create a collision after the check.

Tests: [remote transport](../../tests/specs/remote-transport.ts) covers chained rewrites, push destination tag collisions, relative URL rewrites, and generic SSH paths. [Workspace publication](../../tests/specs/workspace-publication.ts) covers batched lookups and history reuse. [Publish history](../../tests/specs/publish-history.ts) covers the `push.followTags` override. [Lifecycle hooks](../../tests/specs/lifecycle-hooks.ts) covers repo-local and global rewrites used by prepack.

## Decision: require one push URL for every publication

**Maintainer-approved 2026-11-15.** Reject a configured remote with multiple push URLs before packing, including multiple `url` values when no `pushurl` is set. The error never prints destination URLs. It names the remote only when the name matches `[\w.-]+`, and otherwise says "Selected remote", because a remote name could contain credentials. It suggests separate remotes or `--remote <url>`.

**Known limitation:** the check counts configured `url` and `pushurl` entries after resets, not the push URLs Git resolves. It rejects the rare case where several `url` entries are reduced to one push URL by `pushInsteadOf`. Before this decision, multi-package publications counted raw entries without applying resets. Revisit if a user reports this case.

This is a breaking change: multiple push URLs worked in released versions, including v2.5.0 ([#63](https://github.com/privatenumber/git-publish/pull/63)). Standalone and single-package workspace publications no longer mirror to multiple destinations in one invocation, and the partial-outcome report for a failed mirror push is removed. Separate invocations can target each destination, but do not guarantee identical publication commits or atomicity across destinations. Multi-package workspace publications already rejected multiple destinations.

The push strategy still distinguishes normal pushes, standalone force pushes, and workspace force-with-lease pushes. Remote resolution establishes one destination for the rest of the publication.

## Credentials

Install specifiers omit passwords and keep usernames only for SSH. URL and SCP-like remotes with a query or fragment are rejected before packing, including file URLs. Local filesystem paths can contain `?` and `#`; these characters are encoded in the install URL. Unsupported-transport and multiple-URL errors name the remote only when its name matches `[\w.-]+`; otherwise they use a generic label. Displayed scheme URLs with userinfo, queries, or fragments are redacted, except for strict SSH URLs with a bare username. The display redactor also covers helper commands and SCP queries or fragments when the SCP URL includes a username. SCP-like URLs without a username are not covered. Tests: [`tests/specs/error.ts`](../../tests/specs/error.ts), [`tests/specs/github-remotes.ts`](../../tests/specs/github-remotes.ts), and [`tests/specs/remote-transport.ts`](../../tests/specs/remote-transport.ts).

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

Reported as [npm/cli#10249](https://github.com/npm/cli/issues/10249), which contains the full reproducer. The current [branch-channel design](./branch-channel.md) no longer emits conflicting pins: the command and the runtime manifest use the same branch specifier for a given package, so the non-hosted comparison cannot conflate two different selectors emitted for that package in the same publication. The generic publish warning was removed. npm can still keep an old commit if the consumer retains a direct SHA pin or mixes in a different selector for the same package and URL. Replace old direct pins with the printed branch commands when migrating.

## npm needs the remote's HEAD to resolve

npm cannot install any Git dependency from a non-hosted remote whose `HEAD` names a missing branch. A bare repository that only receives git-publish pushes has this state: `git init --bare` points `HEAD` at the default branch, and git-publish pushes only `npm/*` branches. [`clone.js` in @npmcli/git v8.0.0](https://github.com/npm/git/blob/v8.0.0/lib/clone.js#L56), which npm 12.2.2 bundles, reads the `HEAD` ref without a check:

```text
if (revDoc.sha === revs.refs.HEAD.sha) {
```

Observed on Fri Nov 20 2026 with npm 12.2.2, pnpm 12.21.0, and Git 2.54.0. Create a bare remote, push one branch named `npm/a`, and install its commit:

```text
$ npm i --allow-git=root 'git+file:///tmp/gp-head-repro/remote.git#<commit>'
npm error Cannot read properties of undefined (reading 'sha')
```

After `git symbolic-ref HEAD refs/heads/npm/a` in the bare repository, the same command succeeds. `pnpm add` succeeds in both states. The bug is reported as [npm/git#116](https://github.com/npm/git/issues/116). GitHub, GitLab, and Bitbucket repositories always have a resolvable default branch, so hosted remotes are unaffected. A self-hosted remote used only for publication needs a `HEAD` that names an existing branch. git-publish does not check this.
