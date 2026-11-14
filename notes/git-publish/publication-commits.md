# Publication commits

**Decision.** Build publication trees with `git fast-import` directly from tarball entries, then create commits with `git commit-tree`. The published tree retains the packed file bytes, except for the intended `package.json` rewrite, regardless of Git ignore rules, attributes, clean filters, or commit hooks. Package lifecycle hooks can still change files before they are packed. Verified 2026-11-10 with Git 2.54.0.

## Mechanism

See [Source snapshot](#source-snapshot) for which commit and which untracked files are packed.

For each package, [`import-tarball.ts`](../../src/package-publication/import-tarball.ts) streams the gunzipped tar entries into one `git fast-import` process as marked blobs. Regular files use mode `100644` or `100755` according to their executable bits; symlinks use mode `120000` and their target as the blob. A hard link reuses its source's blob mark but uses its own mode. A link to `package.json` uses a separate mark for the original packed bytes, since the manifest itself may have been rewritten; a `package.json` that is itself a link is rejected. After reading the tarball, git-publish checks symlink chains for escaping targets and loops, then writes a parentless scratch commit, clears its tree with `deleteall`, and adds the marked paths in sorted order. Symlink validation is conservative: it rejects Windows path syntax and treats paths case-insensitively, so some links valid on case-sensitive POSIX systems are rejected. Directories are skipped. Unsupported types and unsafe paths are rejected. Paths use Git's C-style quoting with three-digit octal escapes for special bytes.

Only `package.json` is buffered. [`prepare.ts`](../../src/package-publication/prepare.ts) validates it, pins workspace dependencies, orders fields, and strips preparation scripts and development-only fields. The file list and sizes reflect the emitted bytes. If the imported tree equals its parent's tree, the parent commit is reused. Otherwise, `git commit-tree` creates the publication commit from that tree, with the existing parent unless `--fresh` is used. A temporary ref keeps that commit reachable until the push, including while later packages run lifecycle hooks. When `commit.gpgSign` is true, git-publish passes `-S` to preserve commit signing. On Git 2.54.0 with SSH signing configured, `git -c commit.gpgSign=true commit-tree <tree> -m x` produced no `gpgsig` header; adding `-S` produced one. The test "signs publication commits when Git signing is enabled" verifies the published commit.

The isolated repository is a [non-bare clone without checkout](../../src/publish-repository/create.ts), and the separate pack worktree remains for package lifecycle hooks. A bare clone fails ordinary Git commands when `safe.bareRepository=explicit`, while the non-bare clone supports that setting. Neither fast-import nor commit-tree runs the user's `post-commit` hook for publication commits.

## Source snapshot

**Decision.** git-publish packs one source commit, captured once at startup, plus untracked files from npm's working-directory file list. It requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`, matching npm-packlist. Decided 2026-11-14 with npm 12.2.2 (npm-packlist 11.3.0), pnpm 12.18.0, Yarn 4.18.1 and 1.22.22, Bun 1.4.4, and Git 2.54.0.

### Captured commit

- `git symbolic-ref -q HEAD` captures the branch ref first; `git rev-parse --verify --quiet <ref>^{commit}` resolves that exact ref, or `HEAD^{commit}` when detached. The branch name, exact-tag fallback, short SHA, `{gitSha}`, JSON `source.commit`, and newly created publication commit message derive from this capture. A reused publication commit keeps its original message. Resolving the captured ref keeps the name and commit aligned if HEAD switches between calls.
- `git rev-parse --verify --quiet <ref>^{commit}` exits 1 when the ref does not resolve to a commit, including an unborn or deleted branch. The error asks for a commit before publishing.
- Planning reads the live checkout, including ignored configuration, before an isolated checkout is created at the captured SHA.
- After planning, including dry runs, and before copying each package, git-publish checks the symbolic ref or detached state, the ref's commit, and the tracked tree's cleanliness. A mismatch aborts with `The source checkout changed during publication. Keep <name> at <short sha> until git-publish finishes.`
- These checks are not atomic with planning or copying. Concurrent processes can change the source between checks; changing the checkout during publication is unsupported.
- Internal checkout, reset, and clean operations disable Git hooks but retain smudge filters.
- Package manager detection reads the live checkout, including ignored lockfiles.
- Copying skips destinations with symlink or non-directory ancestors in the pack checkout.
- Package paths must resolve inside the isolated checkout; symlinks that escape it are rejected before copying or packing.

### Untracked files copied into the pack checkout

npm runs `prepack` and `prepare` in the package directory and packs that directory as the hooks leave it ([libnpmpack](https://github.com/npm/cli/tree/latest/workspaces/libnpmpack), pacote `lib/dir.js:33-51`). Gitignored build output is therefore packed, and a bundler that does not empty its output directory publishes stale chunks with `npm publish` too ([#96](https://github.com/privatenumber/git-publish/issues/96)). Cleaning stale output is the build's job, for example pkgroll's `--clean-dist`.

For each package, npm-packlist lists candidates in the live directory using the manifest normalized by `@npmcli/package-json` and the workspace map from `@npmcli/map-workspaces`, as in npm's Arborist. Bundled dependencies are removed from the stub tree. Regular files are copied exclusively, preserving their modes; existing destinations and unsafe ancestors are skipped. npm-packlist excludes symlinks and `.git`, but lists files inside nested repositories and submodules, so those files come from the live checkout. The package manager applies its own rules afterward.

### Measurements

In rolldown (11,408 tracked files and 9.3 GB untracked, mostly `target/`), npm-packlist measurements were:

| Step | Result |
| --- | --- |
| `packages/rolldown` with `files` | 47 files, 29 ms |
| `packages/rolldown` without `files` | 2,107 files, 1.2 s |
| Repository root without `files` | 15,494 files, 14.1 s |

This is the same walk npm pack performs, so its cost matches npm's own file listing.

### Rejected alternatives

- **Plan from the captured checkout:** ignored configuration such as `.npmrc` and lockfiles is missing.
- **Tolerate mid-run source changes:** review rounds found divergences involving symlink aliases, Unicode normalization, and missing manifests.
- **Skip the copy when `prepack` exists:** `"prepack": "clean-pkg-json"` does not build, so that package would publish without `dist`.
- **Ask the package manager for its file list:** `yarn pack --dry-run` (Yarn 4) runs `prepack` even with `YARN_ENABLE_SCRIPTS=0`, Yarn 1 has no dry run, and `pnpm pack --dry-run` runs scripts unless given `--ignore-scripts`.
- **Copy every untracked file:** local repositories hold up to 20 GB of untracked files; the root listing alone takes 1 s in rolldown.
- **Git ignore rules and pathspecs (option D):** parent `.gitignore` and `.git/info/exclude` apply when npm would ignore neither; npm chooses `.npmignore` or `.gitignore` per directory; Git's case folding is ASCII-only. Three review rounds found new mismatches.
- **fast-glob over the live directory, filtered by `git ls-tree`:** path strings disagreed for `./dist`, a symlink alias wrote through to a captured file, files committed after the capture were copied, submodule files looked untracked, and `src/*` was not recursive.
- **A JS glob matcher over all untracked files:** it would duplicate npm's file-list rules and cannot limit Git's traversal.

Precedent: [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new/blob/657315c454cc07146ab93c7ba5f47e2b4bd2e8c3/packages/cli/index.ts#L942-L951) runs the package manager's pack in the live directory, and [yalc](https://github.com/wclr/yalc/blob/3b834e488837e87df47414fd9917c10f07f0df08/src/copy.ts#L151) lists files with npm-packlist in the live directory. Neither packs a commit snapshot.

### Limits

- Yarn and Bun have different packing rules, but the copy uses npm's list for every manager. Bun omits an untracked `main` outside `files`; npm and pnpm include it.

Revisit if a package manager offers a script-free file listing for every supported version, or if users need publication to exclude live build output entirely.

## Why not stage the extracted files?

The isolated clone [copies Git configuration](../../src/publish-repository/git-config.ts), including global ignore and filter settings. Git's [`git add` documentation](https://git-scm.com/docs/git-add) states: "The git add command will not add ignored files by default." Git's [`gitattributes` documentation](https://git-scm.com/docs/gitattributes) says the `text` attribute normalizes line endings to LF in the index. Clean filters can also transform the file when it is staged.

On the develop implementation, the tests "publishes packed files excluded by global Git configuration" and "preserves packed CRLF bytes despite global autocrlf" failed. The clean-filter test "preserves packed bytes despite a Git clean filter" produced `bbb` where the packed bytes were `aaa`. These tests are in [`tests/specs/publish-history.ts`](../../tests/specs/publish-history.ts).

## Known limitations

On POSIX, interruption sends SIGTERM to the subprocess's process group and waits for the direct subprocess to exit. Descendants that create another process group or session, or ignore SIGTERM, can survive. On Windows, only the direct child is signalled.

The earlier direct-child-only decision was reversed after testing on Debian 12 with Node 26.13.0. npm ran a prepack hook through a separate `/bin/sh -c` process; after git-publish exited, the hook was orphaned with PPID 1 and state `Sl` in three of three runs.

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
