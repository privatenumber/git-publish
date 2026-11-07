# git-publish

Project decisions for publishing packages, including monorepo packages, to Git branches.

- [Monorepo install sets](./monorepo-install-sets.md): why each package gets its own branch and consumers install the whole set as root dependencies, which alternatives were rejected, and how the design scales.
- [Workspace dependency resolution](./workspace-dependency-resolution.md): which manifest entries count as internal dependencies for each package manager, and how peers, optional dependencies, aliases, private packages, and pack hooks are handled.
- [Remote URLs](./remote-urls.md): which repository install URLs name, how credentials are kept out of output, and the npm commit-pin limitation for non-hosted servers.
