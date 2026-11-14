# Reading workspace dependencies from an install

**Result:** Installed targets are useful evidence for runtime edges, but realpaths alone are not a safe replacement for the publication graph. A stale install gives the wrong answer, pnpm's peer target differs from the publication peer, and Yarn PnP has no `node_modules` tree. Yarn's verbose workspace list is not a substitute for per-dependency resolution. Verified 2026-11-14 against git-publish develop commit `59bb1e0f33cd9005bf5ea070d5097c8b12fe3206`.

## Method

Built that commit from `git archive develop`, `pnpm install --frozen-lockfile`, and `pnpm build` in a temporary directory. Node was 26.13.0, npm 12.2.2, pnpm 12.18.0, Yarn 4.18.1 (`yarn-berry`), and Bun 1.4.4. Each fixture had a private root with `workspaces: ["packages/*"]`, `app@1.0.0`, and local `is-number@1.0.0` in `packages/core`. The registry has `is-number@2.1.0`, so `^2.0.0` is a real external alternative. pnpm used its default workspace-linking configuration and linker. Yarn had `nodeLinker: node-modules` or `pnp` in its root `.yarnrc.yml`; Bun and pnpm used their default linkers. Catalogs were defined in the manager's root configuration. For Yarn, an empty `yarn.lock` isolated each fixture from the build's enclosing project, and `CI` was unset so initial install could write it.

For each fixture, ran the manager's install from the root, then `node <build>/dist/index.js --dry` from `packages/app` in a locally committed Git repository with a dummy GitHub remote. The dry run prints the planned packages and does not pack or push. Separately ran the manager's pack command from `app` and read the packed `package.json`. The install result is not inferred from pack: npm, for example, packed unsupported protocols without validating them. For node-modules fixtures, looked for `node_modules/<dependency-key>` at `app`, `packages`, and root, in that order, and compared the resolved realpath to `packages/core`. No matching path was found in the tested ancestors outside the root. For PnP, also called `require('pnpapi').resolveToUnqualified(key, appDirectory + '/')` with `node --require <root>/.pnp.cjs`; this returns a workspace path or a registry zip path. Ran `yarn workspaces list -v --json` independently.

Case 9 installed `workspace:*`, then changed the app manifest to `^2.0.0` without reinstalling; npm cannot install `workspace:*`, so its initial specification was `^1.0.0`. The changed manifest was committed before the dry run. Case 10 skipped install. No-install Bun had no lockfile, so git-publish detected it as npm; the displayed dry result is that observed fallback, not a verified Bun-specific plan.

## Results

Each cell is `plan / installed target / verdict`. `I` means the local package is included or resolved; `E` means it is not included or a registry package is resolved; `-` means no installed path; `!` means the current planner errors. `M` means the current plan and installed target agree for this fixture, not that the algorithm is generally proven. `D` means they differ. `S` means a proposed fail-closed implementation must stop, rather than classify the missing, stale, or unsupported installation as external. The raw PnP filesystem lookup is `-` in every PnP case; its table target is the separately tested PnP API, marked with `P`. A PnP implementation must explicitly support that API or stop. For peers the publication target is a separate policy question, not necessarily the target installed in the source workspace.

| Case | npm | pnpm | Yarn node-modules | Yarn PnP | Bun |
| --- | --- | --- | --- | --- | --- |
| 1. `workspace:*` | I / - / S | I / I / M | I / I / M | I / P:I / M | I / I / M |
| 2. `^1.0.0` | I / I / M | E / E / M | I / I / M | I / P:I / M | I / I / M |
| 3. `^2.0.0` | E / E / M | E / E / M | E / E / M | E / P:E / M | E / E / M |
| 4. catalog `workspace:*` | ! / - / S | I / I / M | I / I / M | I / P:I / M | I / I / M |
| 5. catalog `^2.0.0` | ! / - / S | E / E / M | E / E / M | E / P:E / M | E / E / M |
| 6. alias `npm:is-number@^1.0.0` | E / E / M | E / E / M | E / I / D | E / P:I / D | E / I / D |
| 7. peer `^1.0.0` | I / I / M | I / E / D | I / I / M | I / P:- / D | I / I / M |
| 8. optional `^1.0.0` | I / I / M | E / E / M | I / I / M | I / P:I / M | I / I / M |
| 9. stale install | E / I / S | E / I / S | E / I / S | E / P:I / S | E / I / S |
| 10. no install | I / - / S | I / - / S | I / - / S | I / - / S | I / - / S |

All installs succeeded except npm cases 1, 4, and 5: npm reported `EUNSUPPORTEDPROTOCOL` for `workspace:` or `catalog:`. Case 10 did not run install. All packs succeeded, including case 10 and the npm unsupported-protocol cases. All dry runs succeeded except npm cases 4 and 5, which reported that the catalog reference could not be resolved. Pack output preserved npm's unsupported strings. For supported managers, `workspace:*` packed to `1.0.0`, except Yarn's `catalog:` pointing to `workspace:*` packed to the literal `workspace:*`. Registry catalog packed to `^2.0.0`; aliases and plain ranges remained unchanged. pnpm's case 7 resolved registry `is-number@1.1.2`, while the plan included local `is-number@1.0.0` as a peer. These observations concern this fixture, not all optional-install modes, aliases, or peer contexts.

The alias discrepancy is actionable evidence that a manager can link an `npm:` alias to a workspace even though the current plan omits it. It does not by itself prove a complete successful publication or a valid rewritten packed alias. Conversely, in pnpm's peer case, copying the installed target would omit a peer the current install-set policy intentionally includes; see [workspace dependency resolution](./workspace-dependency-resolution.md#peers).

## Yarn query and PnP

For both Yarn linkers, `yarn workspaces list -v --json` reported the `app` workspace's `workspaceDependencies` as `["packages/core"]` in case 5 even though the installed target was registry `is-number@2.1.0`. It returned `[]` in cases 6 and 7, despite case 6 resolving the alias to the local package and the current plan including the peer in case 7. After the stale edit in case 9 it returned `[]` and `mismatchedWorkspaceDependencies: ["is-number@^2.0.0"]`, while PnP still resolved the old local package. It also returned a local workspace edge in the no-install case. Thus this query does not establish installed per-key edges or install freshness.

PnP's `resolveToUnqualified` produced the expected workspace path for cases 1, 2, 4, 6 and 8, and a cache zip path for cases 3 and 5. For case 7 it threw `MODULE_NOT_FOUND` with `Your application tried to access is-number, but it isn't declared in your dependencies`; for case 9 it returned the stale workspace path. This is a promising runtime-edge mechanism, not a tested solution for peers, virtual peer instances, stale metadata, or untrusted PnP loaders. A zip path also cannot be treated as an ordinary directory realpath without accounting for PnP's filesystem implementation.

## Conditions for adoption

- Establish freshness before trusting any target, including catalog and configuration changes, installed state, omitted dependencies, and the package manager's selected version and linker. Lockfile presence or a matching range alone is insufficient; no non-mutating, complete freshness check was established here. Fail closed when freshness cannot be established. Validate the packed target version and range separately because pack hooks can change them.
- Give peers an explicit publication policy independent of the source runtime lookup. An absent or registry-resolved peer is not proof that it is outside the intended install set. Optional dependencies can be absent due to install options or platform restrictions; missing must not silently mean external.
- Resolve each dependency key to its actual target, including aliases, and preserve the correct packed-manifest rewrite semantics. Compare canonical package roots, not a naive string prefix that mistakes a neighboring path for a descendant. Node's real lookup can walk above the workspace; define and test that boundary deliberately.
- Implement and validate a PnP-specific resolver or explicitly reject PnP. Do not infer installed edges from `yarn workspaces list -v`. Test multiple versions, Yarn virtual peer contexts, different linker layouts, `file:`/`link:`, absent and optional peers, and actual end-to-end publication before replacing the current planner.

The matrix is a bounded experiment, not a compatibility guarantee. It does not establish an install-state integrity protocol or compare the final pushed manifests. The temporary fixtures and build were removed after the observations were recorded.
