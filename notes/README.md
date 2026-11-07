# Engineering research notes

Tracked maintainer references for the tools and contracts that shape git-publish.

## Ownership

The git-publish folder owns project policy, integration decisions, and cross-tool synthesis. Package-manager behavior that these decisions depend on is cited inline beside each decision, using pinned upstream releases or public issues.

## Index

| Folder | Owns |
| --- | --- |
| [git-publish/](./git-publish/README.md) | Monorepo publication design, workspace dependency resolution, and remote URL policy |

## Evidence

Cite upstream facts beside the claim using primary sources accessible to the intended readers, preferably pinned releases or commits. Ground project behavior in repository source or tests, and label decisions with their rationale. Distinguish documented and observed behavior from inference. Keep executable contracts in the test suite.

## Maintenance

When upstream evidence changes, update the notes and identify affected project decisions and tests. Package-manager policies in particular change between majors; recheck the version boundaries recorded here before relying on them.
