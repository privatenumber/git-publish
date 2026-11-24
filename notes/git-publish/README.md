# git-publish

Project decisions for publishing packages, including monorepo packages, to Git branches.

- [Branches as a prerelease channel](./branch-channel.md): why manifests and install commands use moving branches, how package managers resolve them, and what lockfiles pin.
- [Monorepo install sets](./monorepo-install-sets.md): why each package gets its own branch, why install commands list only selected packages and required peers, and which alternatives were rejected.
- [Workspace dependency resolution](./workspace-dependency-resolution.md): which manifest entries count as internal dependencies for each package manager, and how peers, optional dependencies, aliases, private packages, and pack hooks are handled.
- [Cost of workspace closure publication](./workspace-closure-cost.md): why closure publication stays: a removal spike saved about 17% of `src/`, dropped no runtime dependency, and still needed detection.
- [Reading workspace dependencies from an install](./read-install-experiment.md): why installed targets can't replace the publication graph (stale installs, peers, Yarn PnP), measured across npm, pnpm, Yarn, and Bun.
- [Remote URLs](./remote-urls.md): which repository install URLs name, how credentials are kept out of output, and npm's Git resolution limitations for non-hosted servers.
  See [open scope questions](./remote-urls.md#open-scope-questions) for remote-resolution edge cases and the npm ref spelling limitation.
- [Publication performance](./publication-performance.md): where workspace publication time goes, how much parallel packing saves, why unchanged republishes still pack, and how many remote connections each publication makes.
- [Version SHA](./version-sha.md): why `--version-sha` writes `+sha-<commit>` build metadata and `gitHead`, why it names the source commit rather than the package directory's last change, and how reuse ignores the version SHA, measured across npm, pnpm, Yarn, and Bun.
- [Publication commits](./publication-commits.md): why packed entries are streamed directly into Git commits, and which alternatives were rejected.
- [Signal tests](./signal-tests.md): why signal tests run before concurrent fixture setup, and how to distinguish startup failures from signal handling failures.
