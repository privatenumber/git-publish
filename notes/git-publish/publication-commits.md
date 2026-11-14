# Publication commits

**Decision.** Build publication trees with `git fast-import` directly from tarball entries, then create commits with `git commit-tree`. The published tree retains the packed file bytes, except for the intended `package.json` rewrite, regardless of Git ignore rules, attributes, clean filters, or commit hooks. Package lifecycle hooks can still change files before they are packed. Verified 2026-11-10 with Git 2.54.0.

## Mechanism

See [Source snapshot](#source-snapshot) for which commit and which untracked files are packed.

For each package, [`import-tarball.ts`](../../src/package-publication/import-tarball.ts) streams the gunzipped tar entries into one `git fast-import` process as marked blobs. Regular files use mode `100644` or `100755` according to their executable bits; symlinks use mode `120000` and their target as the blob. A hard link reuses its source's blob mark but uses its own mode. A link to `package.json` uses a separate mark for the original packed bytes, since the manifest itself may have been rewritten; a `package.json` that is itself a link is rejected. After reading the tarball, git-publish checks symlink chains for escaping targets and loops, then writes a parentless scratch commit, clears its tree with `deleteall`, and adds the marked paths in sorted order. Symlink validation is conservative: it rejects Windows path syntax and treats paths case-insensitively, so some links valid on case-sensitive POSIX systems are rejected. Directories are skipped. Unsupported types and unsafe paths are rejected. Paths use Git's C-style quoting with three-digit octal escapes for special bytes.

Only `package.json` is buffered. [`prepare.ts`](../../src/package-publication/prepare.ts) validates it, pins workspace dependencies, orders fields, and strips preparation scripts and development-only fields. The file list and sizes reflect the emitted bytes. If the imported tree equals its parent's tree, the parent commit is reused. Otherwise, `git commit-tree` creates the publication commit from that tree, with the existing parent unless `--fresh` is used. A temporary ref keeps that commit reachable until the push, including while later packages run lifecycle hooks. When `commit.gpgSign` is true, git-publish passes `-S` to preserve commit signing. On Git 2.54.0 with SSH signing configured, `git -c commit.gpgSign=true commit-tree <tree> -m x` produced no `gpgsig` header; adding `-S` produced one. The test "signs publication commits when Git signing is enabled" verifies the published commit.

The isolated repository is a [non-bare clone without checkout](../../src/publish-repository/create.ts), and the separate pack worktree remains for package lifecycle hooks. A bare clone fails ordinary Git commands when `safe.bareRepository=explicit`, while the non-bare clone supports that setting. Neither fast-import nor commit-tree runs the user's `post-commit` hook for publication commits.

## Source snapshot

**Decision.** git-publish packs one source commit, captured once at startup, plus the untracked files the package manager would pack from the working directory. Decided 2026-11-14 with npm 12.2.2 (npm-packlist 11.3.0), pnpm 12.18.0, Yarn 4.18.1 and 1.22.22, Bun 1.4.4, and Git 2.54.0.

### Captured commit

- One `git rev-parse` reads the full SHA of `HEAD^{commit}` and the symbolic ref of `HEAD` together. The branch name, the exact-tag fallback, the short SHA, `{gitSha}`, the JSON `source.commit`, and the commit message all derive from this capture. Reading the ref separately let a branch switch publish commit A to `npm/B`.
- `git rev-parse --verify --quiet HEAD^{commit}` exits 1 on an unborn branch and 128 outside a repository, so exit 1 alone means "no commits".
- The isolated checkout is created at the captured SHA before planning. Planning and the private-package check read that checkout, so they describe the commit that is packed. Planning from the live checkout let a `HEAD` move publish a private commit without `--force`.

### Untracked files copied into the pack checkout

npm runs `prepack` and `prepare` in the package directory and packs that directory as the hooks leave it ([libnpmpack](https://github.com/npm/cli/tree/latest/workspaces/libnpmpack), pacote `lib/dir.js:33-51`). Gitignored build output is therefore packed, and a bundler that does not empty its output directory publishes stale chunks with `npm publish` too ([#96](https://github.com/privatenumber/git-publish/issues/96)). git-publish matches this: the pack checkout gets the untracked files the package manager would see, and cleaning stale output is the build's job, for example pkgroll's `--clean-dist`.

For each package, git-publish runs `git ls-files --others -z` in the live package directory and copies the listed files with `fs.cp` (`verbatimSymlinks`, no overwrite). Git lists Git paths, does not descend through tracked symlinks or into submodules, and omits files that are tracked live, so no copy can overwrite or alias captured content. The listed set is a superset; the real pack filters it.

- **With `files`:** npm normalizes each entry by stripping leading `!`, `./`, one leading `/`, and trailing `/`, expands it with `glob` (`dot: true`), and includes the contents of matched directories ([`npm-packlist` v11.3.0 `lib/index.js:334-379`](https://github.com/npm/npm-packlist/blob/v11.3.0/lib/index.js#L334-L379)). git-publish passes `:(glob)E` and `:(glob)E/**` for entries that use only `*`, `?`, `[...]`, and `**`, which Git's glob pathspecs match the same way. For entries with braces or extglobs, it passes the static prefix before the first glob segment (the package directory when the first segment has one). `!` entries are skipped, because npm applies entries as ordered last-match-wins rules and a later entry can re-include a negated path.
- **Always included:** `main`, `browser`, and each `bin` path ([`:383-397`](https://github.com/npm/npm-packlist/blob/v11.3.0/lib/index.js#L383-L397)) as `:(literal)` pathspecs, and README, COPYING, LICENSE, and LICENCE at the package root ([`:316-319`](https://github.com/npm/npm-packlist/blob/v11.3.0/lib/index.js#L316-L319)) as `:(glob,icase)`.
- **Without `files`:** `--exclude-per-directory=.npmignore` when the package root has `.npmignore`, otherwise `--exclude-standard`, plus `--exclude=node_modules`. In experiments, Git's lists matched `npm pack --dry-run --json --ignore-scripts` for both cases.

### Measurements

In rolldown (11,408 tracked files and 9.3 GB untracked, mostly `target/`), `packages/rolldown` with `files: ["bin", "cli", "dist", "!dist/*.node"]`:

| Step | Result |
| --- | --- |
| `git ls-files --others` with the `files` pathspecs | 45 files, 19 ms |
| `git ls-files --others --exclude-standard` (no-`files` form) | 42 ms |
| All untracked files in the package directory | 605 files, 38 ms |
| All untracked files at the repository root | 65,334 files, 1.0 s |
| `fs.cp` of the 45 files (97 MB, with the skipped `!` entry's `.node` binary) | 98 ms |

### Rejected alternatives

- **Skip the copy when `prepack` exists:** `"prepack": "clean-pkg-json"` does not build, so that package would publish without `dist`.
- **Ask the package manager for its file list:** `yarn pack --dry-run` (Yarn 4) runs `prepack` even with `YARN_ENABLE_SCRIPTS=0`, Yarn 1 has no dry run, and `pnpm pack --dry-run` runs scripts unless given `--ignore-scripts`.
- **Copy every untracked file:** local repositories hold up to 20 GB of untracked files; the root listing alone takes 1 s in rolldown.
- **fast-glob over the live directory, filtered by `git ls-tree`:** path strings disagreed for `./dist`, a symlink alias wrote through to a captured file, files committed after the capture were copied, submodule files looked untracked, and `src/*` was not recursive.
- **A JS glob matcher over all untracked files:** exact, but it adds a dependency or relies on `path.matchesGlob`, and it cannot limit Git's traversal; the superset is cheap to copy.

Precedent: [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new/blob/657315c454cc07146ab93c7ba5f47e2b4bd2e8c3/packages/cli/index.ts#L942-L951) runs the package manager's pack in the live directory, and [yalc](https://github.com/wclr/yalc/blob/3b834e488837e87df47414fd9917c10f07f0df08/src/copy.ts#L151) lists files with npm-packlist in the live directory. Neither packs a commit snapshot.

### Limits

- Untracked files inside submodules are not copied.
- Nested `.npmignore` and `.gitignore` precedence, and package managers whose rules differ from npm's, are approximated by the superset. Bun omits an untracked `main` outside `files`; npm and pnpm include it.
- `directories.bin` is not expanded.

Revisit if a package manager offers a script-free file listing for every supported version, or if users need publication to exclude live build output entirely.

## Why not stage the extracted files?

The isolated clone [copies Git configuration](../../src/publish-repository/git-config.ts), including global ignore and filter settings. Git's [`git add` documentation](https://git-scm.com/docs/git-add) states: "The git add command will not add ignored files by default." Git's [`gitattributes` documentation](https://git-scm.com/docs/gitattributes) says the `text` attribute normalizes line endings to LF in the index. Clean filters can also transform the file when it is staged.

On the develop implementation, the tests "publishes packed files excluded by global Git configuration" and "preserves packed CRLF bytes despite global autocrlf" failed. The clean-filter test "preserves packed bytes despite a Git clean filter" produced `bbb` where the packed bytes were `aaa`. These tests are in [`tests/specs/publish-history.ts`](../../tests/specs/publish-history.ts).

## Known limitations

A consumer with a custom symmetric clean/smudge filter for a path in the packed `.gitattributes` may get transformed bytes on checkout. Git LFS 3.8.1 passes ordinary content through: in a fresh repository, `printf 'hello\n' | git lfs smudge x.txt` printed `hello`, reported `Pointer file error: Unable to parse pointer`, and exited 0; the former clean-filtered pointers were also unsafe because git-publish [pushes with `--no-verify`](../../src/package-publication/push.ts), skipping LFS's pre-push upload.

LFS-tracked files are published as regular Git blobs, so hosting limits apply; for example, [GitHub rejects files larger than 100 MiB](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github). Publishing LFS pointers instead would require applying clean filters again, which would change the packed bytes.

Yarn 1 can pack a symlinked `package.json`, and git-publish rejects it with an error. Supporting it requires reading the link target's bytes, which may appear later in the tarball, so it would need a second pass; revisit if users report this case.

## Alternatives

- `git add --force` includes ignored files, but still applies clean filters and end-of-line conversion. Setting `core.attributesFile=/dev/null` disables the configured attributes file, not in-tree `.gitattributes` files.
- `git hash-object -w --no-filters --stdin-paths` with `git update-index -z --index-info` avoids clean filters, but Git 2.54.0's `git hash-object -h` has no `-z` option for paths. The [Git 2.53.0 implementation](https://github.com/git/git/blob/v2.53.0/builtin/hash-object.c#L38-L59) reads newline-delimited, optionally C-quoted paths and opens each path, following symlinks. Extracting first can also collapse names differing only by case on a case-insensitive filesystem.
- [ghp-import 2.1.0](https://github.com/c-w/ghp-import/blob/2.1.0/ghp_import.py#L129-L188) uses fast-import with `deleteall` and inline blobs. In contrast, [gh-pages](https://github.com/tschaub/gh-pages/blob/48f62a750216e72c5e89058bb61dffdb8450949d/lib/git.js#L213-L218) and [github-pages-deploy-action](https://github.com/JamesIves/github-pages-deploy-action/blob/0a7f3c779e8b36e23d1205a4b401523609968e9d/src/git.ts#L248-L252) use `git add`.

## Benchmark

The comparison uses ten independent npm workspace packages with 2,000 small JavaScript files each. Each timed invocation publishes all ten packages to a newly initialized local bare remote. Setup and remote creation are outside the timed interval. The benchmark alternates builds and reports the sample standard deviation of five `/usr/bin/time -p` wall-clock measurements per build. It uses Node 26.13.0, npm 11.20.0, Git 2.54.0, and macOS 27.0.1 on an Apple M2 Max. The baseline is develop commit `5a0d0e7abe466e78addf1eeb3703251cf5fe0af3`.

| Build | Runs (seconds) | Mean | Sample standard deviation |
| --- | --- | --- | --- |
| develop | 30.37, 50.29, 28.24, 34.16, 21.52 | 32.92 s | 10.74 s |
| fast-import | 15.40, 10.05, 15.22, 10.02, 10.15 | 12.17 s | 2.87 s |

The wide spread limits the precision of this comparison. It measures end-to-end local publication, not the import step alone. The fast-import measurement predates the addition of `commit-tree` and the non-bare clone, so it does not measure the current implementation.

To reproduce, build each revision separately, then run the following Python script with the two absolute `dist/index.js` paths as arguments. It creates its fixture under the system temporary directory and leaves it there for inspection.

```python
import json, os, pathlib, re, statistics, subprocess, sys, tempfile

root = pathlib.Path(tempfile.mkdtemp(prefix='git-publish-benchmark-'))
source = root / 'workspace'
source.mkdir()
env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null', CI='1')
def run(*args):
    return subprocess.run(args, cwd=source, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

(source / 'package.json').write_text(json.dumps({'private': True, 'workspaces': ['packages/*']}))
for i in range(10):
    package = source / 'packages' / f'p{i}'
    package.mkdir(parents=True)
    (package / 'package.json').write_text(json.dumps({'name': f'benchmark-p{i}', 'version': '1.0.0'}))
    for j in range(2000):
        (package / f'f{j:04}.js').write_text(f'export default {i * 2000 + j};\n')
run('git', 'init', '-q', '--initial-branch=main')
run('git', 'config', 'user.name', 'Benchmark')
run('git', 'config', 'user.email', 'benchmark@example.invalid')
run('git', 'add', '.')
run('git', 'commit', '-qm', 'fixture')
run('git', 'remote', 'add', 'origin', str(root / 'remote-0.git'))
results = [[], []]
for i in range(10):
    remote = root / f'remote-{i}.git'
    run('git', 'init', '--bare', '-q', str(remote))
    run('git', 'remote', 'set-url', 'origin', str(remote))
    output = run('/usr/bin/time', '-p', 'node', sys.argv[1 + i % 2]).stderr
    results[i % 2].append(float(re.findall(r'^real\s+(\d+(?:\.\d+)?)$', output, re.M)[-1]))
for values in results:
    print(values, 'mean', statistics.mean(values), 'stdev', statistics.stdev(values))
```

## Revisit conditions

Revisit the representation if a supported package format requires empty directories or entry types other than regular files, symlinks, and hard links. Git trees do not represent empty directories. Re-evaluate the alternatives if Git adds an appropriate binary-safe batch interface that can consume tar entries without a filesystem checkout.
