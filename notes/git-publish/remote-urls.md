# Remote URLs

**Decision.** Install URLs and manifest branch references use the selected push destination's identity. The transport comes from the fetch URL when possible. See the rewrite limitations below.

## Push destination identity

A branch selector must name the repository that receives the published branch. When `origin` fetches upstream and `remote.origin.pushurl` points at a fork, git-publish uses the fork.

- **Same repository, different transports** (HTTPS fetch, SSH push): the fetch URL is used, because it is usually the consumer-friendly transport.
- **Different repositories on the same hosted provider** (github.com, gitlab.com, bitbucket.org): the fetch URL's transport with the push destination's owner and repository, for example fetch `https://github.com/upstream/r.git` plus push `git@github.com:me/r.git` gives `https://github.com/me/r.git`.
- **Otherwise:** the push URL.

Repository identity ignores the user in HTTP(S) and `git://` URLs, where the user only selects credentials, and on hosted providers. It keeps the user and the home-relative versus absolute path distinction for SSH and SCP URLs on other hosts (`git@server:repo.git` is relative to the SSH user's home; `git@server:/repo.git` is absolute).

Git-publish detects configured remotes with `git remote get-url --push --all -- <name>`, which also finds push-only remotes and validates the configuration. A value that is not a configured remote (`get-url` exits 2) is treated as a URL. When it parses as a local path that does not exist relative to the Git root, git-publish fails before packing, including in dry runs, with `No Git remote named "<value>"` and the configured remote names, because a mistyped name, or a missing default `origin`, would otherwise become a path. The message prints the value only when it matches `[\w.-]+`, as in the multiple-URL error. Existing local paths and URL forms (`file://`, SSH, SCP-like, HTTP(S)) keep the URL behavior; a `file://` URL to a missing path still fails only at the first `ls-remote`. Remote URLs are read as configured (`git config --get-all remote.<name>.url`, `remote.<name>.pushurl`). Git rejects valueless `url` or `pushurl` keys. An explicitly empty entry resets its list, so only entries after the last empty value are used. An empty push list falls back to the URL list; a missing or empty URL list is rejected rather than treating the remote name as a URL. The fetch URL is the first remaining `url`. Without a push list, Git normally pushes to every remaining `url`, but `pushInsteadOf` can select a different push URL. Git applies `url.<base>.insteadOf` at transport time in the isolated clone.

**Known limitation:** an `insteadOf` rule that rewrites an upstream URL to a different repository makes install URLs name the upstream. Transport-only rewrites (`https://github.com/` to `git@github.com:`) keep the same identity and work. Revisit if a user reports the repository-changing case.

Tests: [`tests/specs/remote-transport.ts`](../../tests/specs/remote-transport.ts) ("selects install and history URLs by destination identity", "prints the fork with the fetch transport for a hosted triangular remote", "rejects multiple url destinations before packing", "rejects multiple pushurl destinations before packing"), [`tests/specs/workspace-publication.ts`](../../tests/specs/workspace-publication.ts) ("publishes and reloads a workspace closure from the push destination").

The [conflict check](./branch-channel.md#remote-refs-that-can-conflict) reads the push URL. In normal mode it shares one `ls-remote` with branch history when the history URL and the push URL are the same string. When they differ (the same repository through two transports, such as HTTPS fetch and SSH push), history and conflicts use separate lookups. `--fresh` reads no history, so it runs one lookup on the push URL. The push uses `--no-follow-tags` to avoid creating a conflicting annotated tag after the check.

## Isolated client remotes

The isolated client adds two remotes: one for branch history (the history URL) and one for the push destination. Their names are random for each run, such as `git-publish-<uuid>` and `git-publish-source-<uuid>`, so inherited configuration for a fixed name, such as `remote.publish.url` set through `GIT_CONFIG_COUNT`, cannot redirect them. When the selected remote has an explicit `remote.<name>.pushurl`, the isolated push remote stores it as a `pushurl` too. Git applies `pushInsteadOf` only to push URLs that come from `url`, so the isolated push goes where the user's own `git push` would go.

An empty `--remote` value (`--remote=` or `--remote` with no value) is rejected before any work with `--remote requires a remote name or Git URL.`, including in dry runs. As a URL, the empty string resolves to the source repository itself.

Tests: [`tests/specs/remote-transport.ts`](../../tests/specs/remote-transport.ts) ("rejects an empty --remote before packing", "publishes to the selected remote despite inherited settings for old internal remote names", "ignores pushInsteadOf for an explicit pushurl").

## Decision: unsupported remote setups

**Maintainer-decided Tue Nov 24 2026.** The cases below are unsupported. Each line names the report that would justify revisiting it.

- **Empty rewrite:** a literal `pushInsteadOf` rewrite to an empty value, or another empty effective URL. Revisit when a user reports a configuration that relies on it.
- **Chained rewrite:** transport can apply `insteadOf` again after Git selects a push URL through `pushInsteadOf`. Revisit when a chained rewrite sends a publication to the wrong repository.
- **Relative `pushInsteadOf`:** matching and path resolution can differ because the isolated client runs in a different directory from the source checkout. Revisit when a relative rewrite fails for a user.
- **Command-scope remote:** `remote.<name>.url` and `remote.<name>.pushurl` defined only through `GIT_CONFIG_COUNT`. Native `git push <name>` uses the `pushurl`. `git remote get-url` does not report such a remote, so git-publish rejects the name as an unknown remote, although the error's list of configured remotes includes it. Revisit when a CI setup needs remotes that exist only on the command line.
- **Trailing CR in a local path:** Git output parsing can drop a trailing carriage return from a path. Revisit when a user reports such a path.
- **Scheme aliases:** HTTPS and SSH aliases of one hosted repository that `insteadOf` rewrites to different repositories. git-publish pushes to the right repository but reads history from, and prints, the fetch alias. Revisit when a user reports split destinations behind aliases.
- **Generic SSH `.git` suffix:** `ssh://host/repo` and `ssh://host/repo.git` count as different repositories. Revisit when a server that exposes both forms produces a wrong install URL.
- **Local-path alias:** the printed `git+file:` URL uses the configured local path, not a rewritten one. Revisit when a consumer cannot resolve the configured alias.
- **`pushInsteadOf` and conflict checks:** for a remote without an explicit `pushurl`, a `pushInsteadOf` rule applies to the push but not to the `ls-remote` conflict check. Revisit when the check reads a different repository from the one that receives the push.

The [npm Unicode-whitespace ref spelling limitation](./branch-channel.md#remote-refs-that-can-conflict) is also unsupported. Supporting it would require following npm's ref parsing for generated or imported tags.

**Rejected alternative: run remote commands through the source repository's Git config.** Running `ls-remote`, `fetch`, and `push` in the source repository would make Git resolve every rewrite and command-scope remote natively. It is rejected because `git push` there can update remote-tracking refs to objects that exist only in the temporary object store, which leaves the source repository with refs to missing objects.

## Decision: no guard against pushes into the source repository

**Maintainer-decided Tue Nov 24 2026.** git-publish does not check whether the final push destination is the source repository. Such a guard would protect against a misconfigured local destination, such as a path, `file://` URL, symlink, or linked worktree, that resolves to the source repository. It is not implemented because it requires reimplementing Git's repository discovery, including the `<path>.git` fallback and Git-directory identity, in git-publish.

These checks remain:

- An empty `--remote` value is rejected (see [Isolated client remotes](#isolated-client-remotes)).
- A `--remote` value that is not a configured remote and parses as a local path that does not exist is rejected (see [Push destination identity](#push-destination-identity)).
- `--fresh` pushes with `--force-with-lease` on the tip that the branch lookup read, so it cannot silently overwrite a branch that changed after the lookup.

## Decision: require one push URL for every publication

**Maintainer-approved 2026-11-15.** Reject a configured remote with multiple push URLs before packing, including multiple `url` values when no `pushurl` is set. The error never prints destination URLs. It names the remote only when the name matches `[\w.-]+`, and otherwise says "Selected remote", because a remote name could contain credentials. It suggests separate remotes or `--remote <url>`.

**Known limitation:** the check counts configured `url` and `pushurl` entries after resets, not the push URLs Git resolves. It rejects the rare case where several `url` entries are reduced to one push URL by `pushInsteadOf`. Before this decision, multi-package publications counted raw entries without applying resets. Revisit if a user reports this case.

This is a breaking change: multiple push URLs worked in released versions, including v2.5.0 ([#63](https://github.com/privatenumber/git-publish/pull/63)). Standalone and single-package workspace publications no longer mirror to multiple destinations in one invocation, and the partial-outcome report for a failed mirror push is removed. Separate invocations can target each destination, but do not guarantee identical publication commits or atomicity across destinations. Multi-package workspace publications already rejected multiple destinations.

The push strategy distinguishes normal pushes and `--fresh` force-with-lease pushes, for standalone and workspace publications alike. Remote resolution establishes one destination for the rest of the publication.

## Credentials

Install specifiers omit passwords and keep usernames only for SSH. URL and SCP-like remotes with a query or fragment are rejected before packing, including file URLs. Local filesystem paths can contain `?` and `#`; these characters are encoded in the install URL. Unsupported-transport errors identify configured remotes by name, which can expose credentials if a name is URL-shaped. The multiple-URL error identifies the remote by name only when it matches `[\w.-]+`; otherwise it uses a generic label. Displayed scheme URLs with userinfo, queries, or fragments are redacted, except for strict SSH URLs with a bare username. The display redactor also covers helper commands and SCP queries or fragments when the SCP URL includes a username. SCP-like URLs without a username are not covered. Unsupported-transport errors can also expose helper-shaped or SCP-like configured remote names. Tests: [`tests/specs/error.ts`](../../tests/specs/error.ts), [`tests/specs/github-remotes.ts`](../../tests/specs/github-remotes.ts), and [`tests/specs/remote-transport.ts`](../../tests/specs/remote-transport.ts).

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

Reported as [npm/cli#10249](https://github.com/npm/cli/issues/10249), which contains the full reproducer. The [branch-channel design](./branch-channel.md) uses the same branch selector in the command and runtime manifests, so the comparison cannot conflate two different selectors emitted for the same package in one publication. npm can still keep an old commit if the consumer retains a direct SHA pin or mixes in a different selector for the same package and URL. Replace old direct pins with the printed branch commands when migrating.

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
