# Publication commits

**Decision.** Build publication trees with `git fast-import` directly from tarball entries, then create commits with `git commit-tree`. The published tree retains the packed file bytes, except for the intended `package.json` rewrite, regardless of Git ignore rules, attributes, clean filters, or commit hooks. Package lifecycle hooks can still change files before they are packed. Verified 2026-11-10 with Git 2.54.0.

## Mechanism

For each package, [`import-tarball.ts`](../../src/package-publication/import-tarball.ts) streams the gunzipped tar entries into one `git fast-import` process. The stream starts a temporary commit, includes the existing branch tip as its parent unless `--fresh` is used, and clears the tree with `deleteall`. Each regular file becomes an inline blob with mode `100644` or `100755` according to its executable bits; symlinks use mode `120000` and their target as the blob. A hard link copies a previously imported path with fast-import's `C` command, preserving its mode and size. If its target is `package.json`, the link instead gets the original packed manifest bytes as an inline blob, since the manifest itself may have been rewritten. A `package.json` that is itself a link is rejected. Directories are skipped. Unsupported types and unsafe paths are rejected. Paths use Git's C-style quoting with three-digit octal escapes for special bytes.

Only `package.json` is buffered. [`prepare.ts`](../../src/package-publication/prepare.ts) validates it, pins workspace dependencies, orders fields, and strips preparation scripts and development-only fields. The file list and sizes reflect the emitted bytes. If the imported tree equals its parent's tree, the parent commit is reused. Otherwise, `git commit-tree` creates the publication commit from that tree, with the existing parent unless `--fresh` is used. When `commit.gpgSign` is true, git-publish passes `-S` to preserve commit signing. On Git 2.54.0 with SSH signing configured, `git -c commit.gpgSign=true commit-tree <tree> -m x` produced no `gpgsig` header; adding `-S` produced one. The test "signs publication commits when Git signing is enabled" verifies the published commit.

The isolated repository is a [non-bare clone without checkout](../../src/publish-repository/create.ts), and the separate pack worktree remains for package lifecycle hooks. A bare clone fails ordinary Git commands when `safe.bareRepository=explicit`, while the non-bare clone supports that setting. Neither fast-import nor commit-tree runs the user's `post-commit` hook for publication commits.

## Why not stage the extracted files?

The isolated clone [copies Git configuration](../../src/publish-repository/git-config.ts), including global ignore and filter settings. Git's [`git add` documentation](https://git-scm.com/docs/git-add) states: "The git add command will not add ignored files by default." Git's [`gitattributes` documentation](https://git-scm.com/docs/gitattributes) says the `text` attribute normalizes line endings to LF in the index. Clean filters can also transform the file when it is staged.

On the develop implementation, the tests "publishes packed files excluded by global Git configuration" and "preserves packed CRLF bytes despite global autocrlf" failed. The clean-filter test "preserves packed bytes despite a Git clean filter" produced `bbb` where the packed bytes were `aaa`. These tests are in [`tests/specs/publish-history.ts`](../../tests/specs/publish-history.ts).

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
