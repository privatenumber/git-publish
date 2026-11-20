# git-publish

Project decisions for publishing packages, including monorepo packages, to Git branches.

- [Monorepo install sets](./monorepo-install-sets.md): why each package gets its own branch and consumers install the whole set as root dependencies, which alternatives were rejected, and how the design scales.
- [Workspace dependency resolution](./workspace-dependency-resolution.md): which manifest entries count as internal dependencies for each package manager, and how peers, optional dependencies, aliases, private packages, and pack hooks are handled.
- [Cost of workspace closure publication](./workspace-closure-cost.md): why closure publication stays: a removal spike saved about 17% of `src/`, dropped no runtime dependency, and still needed detection.
- [Reading workspace dependencies from an install](./read-install-experiment.md): why installed targets can't replace the publication graph (stale installs, peers, Yarn PnP), measured across npm, pnpm, Yarn, and Bun.
- [Remote URLs](./remote-urls.md): which repository install URLs name, how credentials are kept out of output, and the npm commit-pin and `HEAD` limitations for non-hosted servers.
- [Publication performance](./publication-performance.md): where workspace publication time goes, why hooks and serial packing dominate, and why unchanged republishes still pack.
- [Publication commits](./publication-commits.md): why packed entries are streamed directly into Git commits, and which alternatives were rejected.
