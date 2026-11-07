import path from 'node:path';
import fs from 'node:fs/promises';
import {
	describe, test, expect, onFinish, onTestFail,
} from 'manten';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import { createGit, createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';
import { createCleanupFailureHook } from '../utils/create-cleanup-failure-hook.ts';

describe('Workspace publication', async () => {
	const remoteFixture = await createGitFixture(undefined, ['--bare']);
	onFinish(() => remoteFixture.rm());
	const { git: remoteGit } = remoteFixture;

	test('publishes and pins an npm sibling file dependency', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				dependencies: { core: 'file:../core' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		}, ['--initial-branch=file-sibling']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		const result = await gitPublish(fixture.getPath('packages/app'));
		onTestFail(() => console.log(result.stdout, result.stderr));
		expect('exitCode' in result).toBe(false);
		const coreCommit = await remote.git('rev-parse', ['npm/file-sibling-core']);
		const manifest = JSON.parse(await remote.git('show', ['npm/file-sibling-app:package.json']));
		expect(manifest.dependencies.core).toBe(`git+file://${remote.path}#${coreCommit}`);
	});

	test('rejects sibling file: peers that consumers cannot resolve', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				peerDependencies: { core: 'file:../core' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		}, ['--initial-branch=file-peer']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		const result = await gitPublish(fixture.getPath('packages/app'));
		onTestFail(() => console.log(result));
		expect('exitCode' in result).toBe(true);
		expect(result.output).toContain('which consumers cannot resolve');
		expect(await remote.git('for-each-ref')).toBe('');
	});

	test('never publishes or prints remote URL credentials', async () => {
		await using credentialRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('credentials', 'https://user:secret@example.test/repo.git');
		await fixture.git('config', [`url.${credentialRemote.path}.insteadOf`, 'https://user:secret@example.test/repo.git']);
		await using output = await createFixture();
		const result = await gitPublish(fixture.getPath('packages/adapter'), ['--fresh', '--json', output.getPath('result.json')]);
		expect('exitCode' in result).toBe(false);
		expect(result.stdout).not.toContain('secret');
		expect(result.stderr).not.toContain('secret');
		expect(await output.readFile('result.json', 'utf8')).not.toContain('secret');
		for (const name of ['core', 'broker', 'adapter']) {
			const manifest = await credentialRemote.git('show', [`npm/credentials-@test/${name}:package.json`]);
			expect(manifest).not.toContain('secret');
		}
	});

	test('preserves source dependency order and reuses unchanged publication commits', async () => {
		await using orderedRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/a/package.json': JSON.stringify({
				name: 'a',
				version: '1.0.0',
				dependencies: {
					z: '1.0.0',
					b: 'workspace:*',
				},
				optionalDependencies: {
					z: '1.0.0',
					x: '1.0.0',
				},
				peerDependencies: {
					z: '1.0.0',
					x: '1.0.0',
				},
				devDependencies: {
					z: '1.0.0',
					x: '1.0.0',
				},
			}),
			'packages/b/package.json': JSON.stringify({
				name: 'b',
				version: '1.0.0',
			}),
		}, ['--initial-branch=order']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', orderedRemote.path]);
		await using commands = await createFixture({
			npm: `#!/bin/sh
if [ "$1" = pack ] && [ -f package.json ]; then
  "${process.execPath}" -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json")); for (const f of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) if (p[f]) p[f] = Object.fromEntries(Object.entries(p[f]).reverse()); fs.writeFileSync("package.json", JSON.stringify(p));'
fi
exec "${path.join(path.dirname(process.execPath), 'npm')}" "$@"
`,
		});
		await fs.chmod(commands.getPath('npm'), 0o755);
		const environment = { PATH: `${commands.path}${path.delimiter}${process.env.PATH}` };
		const packagePath = fixture.getPath('packages/a');
		const first = await gitPublish(packagePath, [], environment);
		expect('exitCode' in first).toBe(false);
		const branches = ['npm/order-a', 'npm/order-b'];
		const commits = await Promise.all(branches.map(branch => orderedRemote.git('rev-parse', [branch])));
		const manifest = JSON.parse(await orderedRemote.git('show', ['npm/order-a:package.json']));
		for (const [field, keys] of Object.entries({
			dependencies: ['z', 'b'],
			optionalDependencies: ['z', 'x'],
			peerDependencies: ['z', 'x'],
		})) {
			expect(Object.keys(manifest[field])).toStrictEqual(keys);
		}
		expect(manifest.devDependencies).toBeUndefined();
		const second = await gitPublish(packagePath, [], environment);
		expect('exitCode' in second).toBe(false);
		expect(await Promise.all(branches.map(branch => orderedRemote.git('rev-parse', [branch])))).toStrictEqual(commits);
	});

	const createChainWorkspace = async (
		branchName: string,
		remote: string,
		{
			adapterSpecification = 'workspace:*',
			corePrivate,
			corePrepack,
			peerSpecification,
		}: {
			adapterSpecification?: string;
			corePrivate?: boolean;
			corePrepack?: string;
			peerSpecification?: string;
		} = {},
	) => {
		const fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}, null, 2),
			'package-lock.json': '{}',
			packages: {
				core: {
					'package.json': JSON.stringify({
						name: '@test/core',
						version: '0.0.0',
						...(corePrivate ? { private: true } : {}),
						...(corePrepack
							? {
								scripts: {
									prepack: corePrepack,
								},
							}
							: {}),
					}, null, 2),
					'index.js': 'module.exports = { core: 1 };',
				},
				broker: {
					'package.json': JSON.stringify({
						name: '@test/broker',
						version: '0.0.0',
						dependencies: {
							'@test/core': 'workspace:*',
						},
					}, null, 2),
					'index.js': 'module.exports = { core: require("@test/core") };',
				},
				adapter: {
					'package.json': JSON.stringify({
						name: '@test/adapter',
						version: '0.0.0',
						dependencies: {
							'@test/broker': adapterSpecification,
						},
						...(peerSpecification
							? {
								peerDependencies: {
									'@test/core': peerSpecification,
								},
							}
							: {}),
					}, null, 2),
					'index.js': 'module.exports = { broker: require("@test/broker") };',
				},
			},
		}, [`--initial-branch=${branchName}`]);
		const { git } = fixture;
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', remote]);
		return fixture;
	};

	test('batches remote branch lookups and fetches for a workspace closure', async () => {
		await using batchRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('batch', batchRemote.path);
		const packagePath = fixture.getPath('packages/adapter');
		const first = await gitPublish(packagePath);
		expect('exitCode' in first).toBe(false);
		const gitCommand = await spawn('which', ['git']);
		const gitPath = gitCommand.stdout;
		await using commands = await createFixture({
			git: `#!/bin/sh
case "$1" in ls-remote|fetch) printf '%s\n' "$1" >> '${fixture.getPath('git-calls')}';; esac
exec '${gitPath}' "$@"
`,
		});
		await fs.chmod(commands.getPath('git'), 0o755);
		const result = await gitPublish(packagePath, [], {
			PATH: `${commands.path}${path.delimiter}${process.env.PATH}`,
		});
		expect('exitCode' in result).toBe(false);
		const calls = await fixture.readFile('git-calls', 'utf8');
		expect(calls.trim().split('\n')).toStrictEqual(['ls-remote', 'fetch']);
	});

	test('does not restore dependencies removed before packing', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('removed-dependency', remote.path);
		await using commands = await createFixture({
			npm: `#!/bin/sh
if [ "$1" = pack ] && [ -f package.json ]; then
  "${process.execPath}" -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json")); if (p.name === "@test/adapter") { delete p.dependencies["@test/broker"]; fs.writeFileSync("package.json", JSON.stringify(p)); }'
fi
exec "${path.join(path.dirname(process.execPath), 'npm')}" "$@"
`,
		});
		await fs.chmod(commands.getPath('npm'), 0o755);
		const result = await gitPublish(fixture.getPath('packages/adapter'), [], {
			PATH: `${commands.path}${path.delimiter}${process.env.PATH}`,
		});
		expect('exitCode' in result).toBe(false);
		const manifest = JSON.parse(await remote.git('show', ['npm/removed-dependency-@test/adapter:package.json']));
		expect(manifest.dependencies?.['@test/broker']).toBeUndefined();
	});

	test('rejects an internal dependency changed by a pack hook', async () => {
		for (const packed of ['npm:other@^1.0.0', 'file:../other', 'git+https://example.test/repo.git']) {
			await using remote = await createGitFixture(undefined, ['--bare']);
			await using fixture = await createChainWorkspace('changed-dependency', remote.path);
			await using commands = await createFixture({
				npm: `#!/bin/sh
if [ "$1" = pack ] && [ -f package.json ]; then
  "${process.execPath}" -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json")); if (p.name === "@test/adapter") { p.dependencies["@test/broker"] = ${JSON.stringify(packed)}; fs.writeFileSync("package.json", JSON.stringify(p)); }'
fi
exec "${path.join(path.dirname(process.execPath), 'npm')}" "$@"
`,
			});
			await fs.chmod(commands.getPath('npm'), 0o755);
			const result = await gitPublish(fixture.getPath('packages/adapter'), [], {
				PATH: `${commands.path}${path.delimiter}${process.env.PATH}`,
			});
			expect(('exitCode' in result) && result.exitCode).toBe(1);
			const output = result.stdout + result.stderr;
			expect(output).toContain('@test/adapter');
			expect(output).toContain('@test/broker');
			expect(output).toContain('workspace:*');
			expect(output).toContain(packed);
			expect(await remote.git('for-each-ref')).toBe('');
		}
	});

	test('publishes and reloads a workspace closure from the push destination', async () => {
		await using upstream = await createGitFixture(undefined, ['--bare']);
		await using destination = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('triangular', upstream.path);
		await fixture.git('config', ['remote.origin.pushurl', destination.path]);
		await using output = await createFixture();
		const args = ['--json', output.getPath('result.json')];
		const first = await gitPublish(fixture.getPath('packages/adapter'), args);
		expect('exitCode' in first).toBe(false);
		const branches = ['core', 'broker', 'adapter'].map(name => `npm/triangular-@test/${name}`);
		const commits = await Promise.all(branches.map(branch => destination.git('rev-parse', [branch])));
		const manifest = JSON.parse(await destination.git('show', [`${branches[1]}:package.json`]));
		expect(manifest.dependencies['@test/core']).toBe(`git+file://${destination.path}#${commits[0]}`);
		const json = await output.readFile('result.json', 'utf8');
		expect(json).toContain(`git+file://${destination.path}#`);
		expect(first.stdout).toContain(`git+file://${destination.path}#`);
		expect(await upstream.git('for-each-ref')).toBe('');
		const second = await gitPublish(fixture.getPath('packages/adapter'), args);
		expect('exitCode' in second).toBe(false);
		expect(await Promise.all(branches.map(branch => destination.git('rev-parse', [branch])))).toStrictEqual(commits);
	});

	for (const [manager, range, internal] of [
		['npm', '^1.0.0', true],
		['npm', '^2.0.0', false],
		['pnpm', '^1.0.0', false],
	] as const) {
		test(`${manager} ${range} ${internal ? 'publishes' : 'leaves external'} plain workspace ranges`, async () => {
			await using rangeRemote = await createGitFixture(undefined, ['--bare']);
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'root',
					private: true,
					workspaces: ['packages/*'],
				}),
				...(manager === 'pnpm'
					? {
						'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
						'pnpm-lock.yaml': '',
					}
					: { 'package-lock.json': '{}' }),
				'packages/app/package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					dependencies: { core: range },
				}),
				'packages/core/package.json': JSON.stringify({
					name: 'core',
					version: '1.2.0',
				}),
			}, ['--initial-branch=plain']);
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', rangeRemote.path]);
			const result = await gitPublish(fixture.getPath('packages/app'));
			expect('exitCode' in result).toBe(false);
			const manifest = JSON.parse(await rangeRemote.git('show', ['npm/plain-app:package.json']));
			if (internal) {
				const commit = await rangeRemote.git('rev-parse', ['npm/plain-core']);
				expect(manifest.dependencies.core).toBe(`git+file://${rangeRemote.path}#${commit}`);
			} else {
				expect(manifest.dependencies.core).toBe(range);
				const branches = await rangeRemote.git('branch', ['--list']);
				expect(branches).not.toContain('npm/plain-core');
			}
		});
	}

	test('publishes private workspace members as dependencies and selected packages', async () => {
		const branchName = 'test-private-workspace-dependency';
		await using fixture = await createChainWorkspace(branchName, remoteFixture.path, {
			corePrivate: true,
		});
		const packagePath = path.join(fixture.path, 'packages/adapter');
		const dryRun = await gitPublish(packagePath, ['--dry']);
		expect('exitCode' in dryRun).toBe(false);
		expect(dryRun.stdout).toContain('@test/core (private)');

		const publication = await gitPublish(packagePath);
		expect('exitCode' in publication).toBe(false);
		expect(await remoteGit('show', [`npm/${branchName}-@test/core:package.json`])).toContain('"private": true');
		const selectedPublication = await gitPublish(fixture.getPath('packages/core'));
		expect('exitCode' in selectedPublication).toBe(false);
	});

	test('requires --force when selecting a private workspace root', async () => {
		await using fixture = await createChainWorkspace('private-root', remoteFixture.path);
		const rejected = await gitPublish(fixture.path, ['.']);
		expect(('exitCode' in rejected) && rejected.exitCode).toBe(1);
		expect(rejected.stderr).toContain('marked as private');
		const forced = await gitPublish(fixture.path, ['.', '--dry', '--force']);
		expect('exitCode' in forced).toBe(false);
	});

	test('publishes all non-private members by default at the workspace root', async () => {
		await using allRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('all', allRemote.path, { corePrivate: true });
		for (const name of ['extra-a', 'extra-b']) {
			await fixture.mkdir(`packages/${name}`);
			await fixture.writeJson(`packages/${name}/package.json`, {
				name,
				version: '1.0.0',
			});
		}
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Add packages']);
		await using output = await createFixture();
		const result = await gitPublish(fixture.path);
		expect('exitCode' in result).toBe(false);
		for (const name of ['core', 'broker', 'adapter']) {
			expect(await allRemote.git('rev-parse', [`npm/all-@test/${name}`])).toMatch(/^[0-9a-f]{40}$/);
		}
		const branches = await allRemote.git('branch', ['--list']);
		expect(branches).not.toContain('test-monorepo');
		const second = await gitPublish(fixture.path, ['--json', output.getPath('publication.json')]);
		expect('exitCode' in second).toBe(false);
		expect(second.stdout).toContain('unchanged');
		const data = await output.readJson<{ packages: { name: string;
			role: string; }[]; }>('publication.json');
		expect(data.packages.filter(item => item.role === 'root').map(item => item.name).sort())
			.toStrictEqual(['@test/adapter', '@test/broker', 'extra-a', 'extra-b']);
		expect(result.stdout).toContain('Package');
		expect(result.stdout).toContain('updated');
		expect(result.stdout).toContain('--json');
	});

	test('publishes npm workspace closures without a lockfile', async () => {
		await using noLockRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				dependencies: { core: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		}, ['--initial-branch=no-lock']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', noLockRemote.path]);
		const result = await gitPublish(fixture.getPath('packages/app'));
		expect('exitCode' in result).toBe(false);
		const commit = await noLockRemote.git('rev-parse', ['npm/no-lock-core']);
		const manifest = JSON.parse(await noLockRemote.git('show', ['npm/no-lock-app:package.json']));
		expect(manifest.dependencies.core).toBe(`git+file://${noLockRemote.path}#${commit}`);
	});

	test('detects a pnpm workspace without a lockfile ahead of stale Yarn locks', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
			}),
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			'yarn.lock': '',
			'.gitignore': 'node_modules',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				dependencies: { core: 'workspace:*' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		}, ['--initial-branch=pnpm-no-lock']);
		// Packing resolves workspace: specifiers from installed dependencies
		await spawn('pnpm', ['install', '--lockfile=false'], { cwd: fixture.path });
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		const result = await gitPublish(fixture.getPath('packages/app'));
		onTestFail(() => console.log(result));
		expect('exitCode' in result).toBe(false);
		expect(result.stdout).toContain('pnpm add');
		const commit = await remote.git('rev-parse', ['npm/pnpm-no-lock-core']);
		const manifest = JSON.parse(await remote.git('show', ['npm/pnpm-no-lock-app:package.json']));
		expect(manifest.dependencies.core).toBe(`git+file://${remote.path}#${commit}`);
	});

	test('publishes a public workspace root as a standalone package', async () => {
		await using rootRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				version: '1.0.0',
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/member/package.json': JSON.stringify({
				name: 'member',
				version: '1.0.0',
			}),
		}, ['--initial-branch=public-root']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', rootRemote.path]);
		const result = await gitPublish(fixture.path);
		expect('exitCode' in result).toBe(false);
		const manifest = JSON.parse(await rootRemote.git('show', ['npm/public-root:package.json']));
		expect(manifest.name).toBe('root');
		const branches = await rootRemote.git('for-each-ref', ['--format=%(refname:short)', 'refs/heads']);
		expect(branches).toBe('npm/public-root');
	});

	test('includes internal runtime dependencies of a public workspace root', async () => {
		await using rootRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				version: '1.0.0',
				workspaces: ['packages/*'],
				dependencies: { member: '^1.0.0' },
			}),
			'package-lock.json': '{}',
			'packages/member/package.json': JSON.stringify({
				name: 'member',
				version: '1.0.0',
			}),
		}, ['--initial-branch=public-closure']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', rootRemote.path]);
		const result = await gitPublish(fixture.path);
		expect('exitCode' in result).toBe(false);
		const commit = await rootRemote.git('rev-parse', ['npm/public-closure-member']);
		const manifest = JSON.parse(await rootRemote.git('show', ['npm/public-closure:package.json']));
		expect(manifest.dependencies.member).toBe(`git+file://${rootRemote.path}#${commit}`);
	});

	test('publishes a peer-only closure of a public workspace root', async () => {
		await using rootRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				version: '1.0.0',
				workspaces: ['packages/*'],
				peerDependencies: { member: '^1.0.0' },
			}),
			'package-lock.json': '{}',
			'packages/member/package.json': JSON.stringify({
				name: 'member',
				version: '1.0.0',
			}),
		}, ['--initial-branch=root-peer']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', rootRemote.path]);
		const result = await gitPublish(fixture.path);
		expect('exitCode' in result).toBe(false);
		expect(await rootRemote.git('rev-parse', ['npm/root-peer-member'])).toMatch(/^[0-9a-f]{40}$/);
		expect(await rootRemote.git('rev-parse', ['npm/root-peer'])).toMatch(/^[0-9a-f]{40}$/);
	});

	test('reports unresolved peers of a public workspace root', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				version: '1.0.0',
				workspaces: ['packages/*'],
				peerDependencies: { missing: 'workspace:*' },
			}),
			'package-lock.json': '{}',
		}, ['--initial-branch=root-peer']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		const result = await gitPublish(fixture.path, ['--dry']);
		expect('exitCode' in result).toBe(false);
		expect(result.stderr).toContain('missing');
		expect(result.stderr).toContain('does not resolve to a workspace package');
	});

	test('publishes members by default for an unnamed workspace root', async () => {
		await using rootRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
			'package-lock.json': '{}',
			'packages/member/package.json': JSON.stringify({
				name: 'member',
				version: '1.0.0',
			}),
		}, ['--initial-branch=unnamed-root']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', rootRemote.path]);
		const result = await gitPublish(fixture.path);
		expect('exitCode' in result).toBe(false);
		expect(await rootRemote.git('rev-parse', ['npm/unnamed-root-member'])).toMatch(/^[0-9a-f]{40}$/);
	});

	test('selects workspace roots by name, path and glob', async () => {
		await using selectionRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('select', selectionRemote.path);
		const result = await gitPublish(fixture.path, ['@test/adapter', './packages/core', './packages/*']);
		expect('exitCode' in result).toBe(false);
		for (const name of ['core', 'broker', 'adapter']) {
			expect(await selectionRemote.git('rev-parse', [`npm/select-@test/${name}`])).toMatch(/^[0-9a-f]{40}$/);
		}
		const invalid = await gitPublish(fixture.path, ['missing', '--dry']);
		expect(('exitCode' in invalid) && invalid.exitCode).toBe(1);
		expect(invalid.stderr).toContain('No workspace package matches "missing"');
	});

	test('reports separate install sets for shared runtime and peer packages', async () => {
		await using setRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/a/package.json': JSON.stringify({
				name: 'a',
				version: '1.0.0',
				peerDependencies: { core: '^1.0.0' },
			}),
			'packages/b/package.json': JSON.stringify({
				name: 'b',
				version: '1.0.0',
				dependencies: { core: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		}, ['--initial-branch=sets']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', setRemote.path]);
		await using output = await createFixture();
		const result = await gitPublish(fixture.path, ['a', 'b', '--json', output.getPath('sets.json')]);
		expect('exitCode' in result).toBe(false);
		const data = await output.readJson<{
			source: { ref: string;
				commit: string; };
			packages: { name: string;
				installSpecifier: string;
				role: string;
				reused: boolean; }[];
			installSets: Record<string, { required: string[];
				optional: string[]; }>;
		}>('sets.json');
		expect(data.source).toStrictEqual({
			ref: 'sets',
			commit: await fixture.git('rev-parse', ['HEAD']),
		});
		expect(data.installSets).toStrictEqual({
			a: {
				required: ['a', 'core'],
				optional: [],
			},
			b: {
				required: ['b', 'core'],
				optional: [],
			},
		});
		const core = data.packages.find(item => item.name === 'core')!;
		expect(core.role).toBe('dependency');
		expect(core.reused).toBe(false);
		const manifest = JSON.parse(await setRemote.git('show', ['npm/sets-b:package.json']));
		expect(manifest.dependencies.core).toBe(core.installSpecifier);
		expect(result.stdout.split(core.installSpecifier)).toHaveLength(3);
		expect(result.stdout).toContain('npm 12+: add --allow-git=root');
	});

	test('reports internal aliases in install sets and warns about npm policy', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				dependencies: { alias: 'workspace:core@*' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		}, ['--initial-branch=alias']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		await using output = await createFixture();
		const result = await gitPublish(fixture.getPath('packages/app'), ['--json', output.getPath('result.json')]);
		expect('exitCode' in result).toBe(false);
		expect(result.stderr).not.toContain('npm 12 needs --allow-git=all for alias "alias"');
		const json = await output.readJson<{ aliases: Record<string, Record<string, string>> }>('result.json');
		expect(json.aliases).toStrictEqual({ app: { alias: 'core' } });
	});

	test('keeps optional-only packages out of root install arguments', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				dependencies: { core: '^1.0.0' },
				optionalDependencies: { optional: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
				dependencies: { leaf: '^1.0.0' },
			}),
			'packages/optional/package.json': JSON.stringify({
				name: 'optional',
				version: '1.0.0',
				os: ['!darwin'],
				dependencies: { leaf: '^1.0.0' },
			}),
			'packages/leaf/package.json': JSON.stringify({
				name: 'leaf',
				version: '1.0.0',
			}),
		}, ['--initial-branch=optional']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		await using output = await createFixture();
		const result = await gitPublish(fixture.getPath('packages/app'), ['--json', output.getPath('result.json')]);
		expect('exitCode' in result).toBe(false);
		const json = await output.readJson<{
			installSets: Record<string, { required: string[];
				optional: string[]; }>;
			packages: { name: string;
				installSpecifier: string; }[];
		}>('result.json');
		expect(json.installSets.app).toStrictEqual({
			required: ['app', 'leaf', 'core'],
			optional: ['optional'],
		});
		const optional = json.packages.find(item => item.name === 'optional')!;
		expect(result.stdout).not.toContain(optional.installSpecifier);
		expect(result.stdout).toContain('Optional workspace dependencies optional install transitively');
		const manifest = JSON.parse(await remote.git('show', ['npm/optional-app:package.json']));
		expect(manifest.optionalDependencies.optional).toBe(optional.installSpecifier);
	});

	for (const manager of ['pnpm', 'yarn', 'bun'] as const) {
		test(`prints the ${manager} install set and applicable note`, async () => {
			await using managerRemote = await createGitFixture(undefined, ['--bare']);
			await using fixture = await createChainWorkspace(`output-${manager}`, managerRemote.path);
			await fixture.rm('package-lock.json');
			if (manager === 'pnpm') {
				await fixture.writeFile('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
				await fixture.writeFile('pnpm-lock.yaml', '');
			} else {
				await fixture.writeFile(manager === 'yarn' ? 'yarn.lock' : 'bun.lock', '');
			}
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Select package manager']);
			const npm = path.join(path.dirname(process.execPath), 'npm');
			await using commands = await createFixture({
				[manager]: `#!/bin/sh
if [ "$1" = --version ]; then echo 1.22.22; exit 0; fi
if [ "$1" = pm ]; then exec '${npm}' pack --pack-destination "$4"; fi
if [ "$1" = pack ] && [ "$2" = --filename ]; then exec '${npm}' pack --pack-destination "$(dirname "$3")"; fi
exec '${npm}' "$@"
`,
			});
			await fs.chmod(commands.getPath(manager), 0o755);
			const result = await gitPublish(fixture.getPath('packages/adapter'), [], {
				PATH: `${commands.path}${path.delimiter}${process.env.PATH}`,
			});
			expect('exitCode' in result).toBe(false);
			expect(result.stdout).toContain(`${manager} add '`);
			if (manager === 'yarn') {
				expect(result.stdout).toContain('@test/adapter@git+file://');
				expect(result.stdout).toContain('approvedGitRepositories');
			} else if (manager === 'pnpm') {
				expect(result.stdout).toContain('blockExoticSubdeps: false');
			} else {
				expect(result.stdout).not.toContain('blockExoticSubdeps');
				expect(result.stdout).not.toContain('allow-git');
			}
		});
	}

	for (const [remoteUrl, packageName, warning] of [
		['git@github.com:owner/repo.git', 'adapter', false],
		['https://gitlab.com/owner/repo.git', 'adapter', false],
		['git@bitbucket.org:owner/repo.git', 'adapter', false],
		['https://git.example.test/owner/repo.git', 'adapter', true],
		['https://git.example.test/owner/repo.git', 'core', false],
	] as const) {
		test(`warns for non-hosted install sets: ${remoteUrl} ${packageName}`, async () => {
			await using warningRemote = await createGitFixture(undefined, ['--bare']);
			await using fixture = await createChainWorkspace('warning', remoteUrl);
			await fixture.git('config', [`url.${warningRemote.path}.insteadOf`, remoteUrl]);
			const result = await gitPublish(fixture.getPath(`packages/${packageName}`), ['--fresh']);
			expect('exitCode' in result).toBe(false);
			expect(result.stderr.includes('npm ignores commit pins for non-hosted Git URLs')).toBe(warning);
		});
	}

	test('writes standalone publication details as JSON', async () => {
		await using standaloneRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'standalone',
				version: '1.0.0',
			}),
		}, ['--initial-branch=standalone']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', standaloneRemote.path]);
		await using output = await createFixture();
		const result = await gitPublish(fixture.path, ['--json', output.getPath('result.json')]);
		expect('exitCode' in result).toBe(false);
		const commit = await standaloneRemote.git('rev-parse', ['npm/standalone']);
		expect(await output.readJson('result.json')).toStrictEqual({
			source: {
				ref: 'standalone',
				commit: await fixture.git('rev-parse', ['HEAD']),
			},
			packages: [{
				name: 'standalone',
				branch: 'npm/standalone',
				commit,
				installSpecifier: `git+file://${standaloneRemote.path}#${commit}`,
				role: 'root',
				reused: false,
			}],
			installSets: {
				standalone: {
					required: ['standalone'],
					optional: [],
				},
			},
			aliases: { standalone: {} },
		});
	});

	test('keeps a literal --branch for an independent workspace package', async () => {
		await using branchRemoteFixture = await createGitFixture(undefined, ['--bare']);
		const { git: branchRemoteGit } = branchRemoteFixture;
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}, null, 2),
			'package-lock.json': '{}',
			packages: {
				adapter: {
					'package.json': JSON.stringify({
						name: '@test/adapter',
						version: '0.0.0',
					}, null, 2),
					'index.js': 'module.exports = 1;',
				},
			},
		}, ['--initial-branch=test-workspace-branch-flag']);
		const { git } = fixture;
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', branchRemoteFixture.path]);

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'), ['--branch', 'custom']);

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(await branchRemoteGit('show', ['custom:package.json'])).toContain('@test/adapter');
		expect(gitPublishProcess.stdout).toContain('npm 12+: add --allow-git=root');
		expect(gitPublishProcess.stdout).not.toContain('Required workspace dependencies');
		expect(gitPublishProcess.stdout).toContain('Pushing 1 package');
	});

	test('pushes a single workspace package to multiple destinations', async () => {
		await using first = await createGitFixture(undefined, ['--bare']);
		await using second = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('mirror', first.path);
		await fixture.git('config', ['--add', 'remote.origin.pushurl', first.path]);
		await fixture.git('config', ['--add', 'remote.origin.pushurl', second.path]);
		const result = await gitPublish(fixture.getPath('packages/core'));
		expect('exitCode' in result).toBe(false);
		const commit = await first.git('rev-parse', ['npm/mirror-@test/core']);
		expect(await second.git('rev-parse', ['npm/mirror-@test/core'])).toBe(commit);
	});

	test('publishes a single workspace package without atomic push support', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await remote.git('config', ['receive.advertiseAtomic', 'false']);
		await using fixture = await createChainWorkspace('no-atomic', remote.path);
		const result = await gitPublish(fixture.getPath('packages/core'));
		expect('exitCode' in result).toBe(false);
		expect(await remote.git('rev-parse', ['npm/no-atomic-@test/core'])).toMatch(/^[0-9a-f]{40}$/);
	});

	test('groups packages under the workspace publication', async () => {
		const branchName = 'test-workspace-progress';
		await using fixture = await createChainWorkspace(branchName, remoteFixture.path, {
			corePrepack: 'node -e "setTimeout(() => {}, 1100)"',
		});

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toContain(`Published "@test/adapter" from "${branchName}"`);
		expect(gitPublishProcess.stdout).toContain('Packages');
		expect(gitPublishProcess.stdout).toContain('@test/core');
		expect(gitPublishProcess.stdout).toMatch(/@test\/core[^\n]*\(\d+(?:\.\d+)?(?:ms|s)\)/);
		expect(gitPublishProcess.stdout).toContain('@test/broker');
		expect(gitPublishProcess.stdout).toContain('@test/adapter');
		expect(gitPublishProcess.stdout).toContain('Pushing 3 packages together');
		expect(gitPublishProcess.stdout).not.toContain('workspace closure');
		expect(gitPublishProcess.stdout.indexOf('→ Install @test/adapter')).toBeGreaterThan(
			gitPublishProcess.stdout.lastIndexOf(`Published "@test/adapter" from "${branchName}"`),
		);
		expect(gitPublishProcess.stdout.split('→ Install @test/adapter')).toHaveLength(2);
	});

	test('retains publication success when cleanup fails', async () => {
		const branchName = 'test-workspace-cleanup-failure';
		await using fixture = await createChainWorkspace(branchName, remoteFixture.path);
		await using hookFixture = await createFixture();
		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'), [], {
			NODE_OPTIONS: await createCleanupFailureHook(hookFixture),
		});

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(await remoteGit('rev-parse', [`npm/${branchName}-@test/adapter`])).toBeTruthy();
		expect(gitPublishProcess.stdout).toContain(`Published "@test/adapter" from "${branchName}"`);
		expect(gitPublishProcess.stdout).toContain('Test cleanup failure at');
		expect(gitPublishProcess.stdout).toContain('→ Install @test/adapter');
	});

	test('ignores an outer workspace beyond the Git root', async () => {
		await using nestedRemoteFixture = await createGitFixture(undefined, ['--bare']);
		const { git: nestedRemoteGit } = nestedRemoteFixture;
		await using outerFixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'outer-workspace',
				private: true,
				workspaces: ['packages/*'],
			}, null, 2),
			'package-lock.json': '{}',
			packages: {
				outer: {
					'package.json': JSON.stringify({
						name: '@test/outer',
						version: '0.0.0',
					}, null, 2),
				},
				inner: {
					'package.json': JSON.stringify({
						name: '@test/inner',
						version: '0.0.0',
					}, null, 2),
					'index.js': 'module.exports = 1;',
				},
			},
		});
		const repositoryPath = outerFixture.getPath('packages/inner');
		const git = createGit(repositoryPath);
		await git.init(['--initial-branch=inner']);
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', nestedRemoteFixture.path]);

		const gitPublishProcess = await gitPublish(repositoryPath);

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toContain('Publishing source "inner" → "npm/inner"');
		expect(await nestedRemoteGit('show', ['npm/inner:package.json'])).toContain('@test/inner');
	});

	test('renders --branch for every package in a workspace closure', async () => {
		await using branchRemoteFixture = await createGitFixture(undefined, ['--bare']);
		const { git: branchRemoteGit } = branchRemoteFixture;
		await using fixture = await createChainWorkspace('test-workspace-derived-branches', branchRemoteFixture.path);

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'), ['--branch', 'preview/{package}']);

		expect('exitCode' in gitPublishProcess).toBe(false);
		for (const branch of ['preview/@test/adapter', 'preview/@test/broker', 'preview/@test/core']) {
			expect(await branchRemoteGit('rev-parse', [branch])).toMatch(/^[0-9a-f]{40}$/);
		}
	});

	test('rejects a literal --branch for a multi-package workspace closure before creating refs', async () => {
		await using collisionRemoteFixture = await createGitFixture(undefined, ['--bare']);
		const { git: collisionRemoteGit } = collisionRemoteFixture;
		await using fixture = await createChainWorkspace('test-workspace-branch-collision', collisionRemoteFixture.path);

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'), ['--branch', 'preview']);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toContain('renders "preview" for both "@test/core" and "@test/broker"');
		expect(gitPublishProcess.stderr).toContain('Include {package}');
		expect(await collisionRemoteGit('for-each-ref')).toBe('');
	});

	for (const {
		title,
		template,
		error,
	} of [
			{
				title: 'rejects unknown workspace branch template placeholders before creating refs',
				template: 'preview/{version}',
				error: 'Unknown branch template placeholder "{version}". Supported placeholders: {gitRef}, {gitSha}, {package}.',
			},
			{
				title: 'rejects invalid rendered workspace branches before creating refs',
				template: 'preview/invalid..{package}',
				error: 'Invalid publish branch "preview/invalid..@test/core".',
			},
		]) {
		test(title, async () => {
			await using validationRemoteFixture = await createGitFixture(undefined, ['--bare']);
			const { git: validationRemoteGit } = validationRemoteFixture;
			await using fixture = await createChainWorkspace('test-workspace-template-validation', validationRemoteFixture.path);

			const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'), ['--branch', template]);

			expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
			expect(gitPublishProcess.stderr).toContain(error);
			expect(await validationRemoteGit('for-each-ref')).toBe('');
		});
	}

	test('rejects {gitSha} without a source commit before creating refs', async () => {
		await using sourceRemoteFixture = await createGitFixture(undefined, ['--bare']);
		const { git: sourceRemoteGit } = sourceRemoteFixture;
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-package',
				version: '1.0.0',
			}),
		}, ['--initial-branch=main']);
		await fixture.git('remote', ['add', 'origin', sourceRemoteFixture.path]);

		const gitPublishProcess = await gitPublish(fixture.path, ['--branch', 'preview/{gitSha}']);

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toContain('Branch template "preview/{gitSha}" uses {gitSha}, but the source repository has no commit.');
		expect(await sourceRemoteGit('for-each-ref')).toBe('');
	});

	test('reports workspace dependency planning errors', async () => {
		const branchName = 'test-workspace-invalid-specification';
		await using fixture = await createChainWorkspace(branchName, remoteFixture.path, {
			adapterSpecification: 'workspace:',
		});

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toContain('Unsupported workspace specification "workspace:"');
		expect(gitPublishProcess.stderr).not.toContain('Pre-bundle these dependencies');
	});

	test('rejects mismatched explicit workspace ranges before packing', async () => {
		await using fixture = await createChainWorkspace('range-mismatch', remoteFixture.path, {
			adapterSpecification: 'workspace:^2.0.0',
		});
		const result = await gitPublish(fixture.getPath('packages/adapter'), ['--dry']);
		expect(('exitCode' in result) && result.exitCode).toBe(1);
		for (const text of ['@test/adapter', '@test/broker', '^2.0.0', '0.0.0']) {
			expect(result.stderr).toContain(text);
		}
	});

	test('publishes internal peers without rewriting the peer range', async () => {
		const branchName = 'test-workspace-peer-diagnostic';
		await using fixture = await createChainWorkspace(branchName, remoteFixture.path, {
			peerSpecification: '^0.0.0',
		});

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stderr).not.toContain('peer dependencies');
		const manifest = JSON.parse(await remoteGit('show', [`npm/${branchName}-@test/adapter:package.json`]));
		expect(manifest.peerDependencies['@test/core']).toBe('^0.0.0');
	});

	test('publishes peer-only targets and their runtime closure', async () => {
		await using peerRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				peerDependencies: { core: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
				dependencies: { leaf: 'workspace:*' },
				peerDependencies: { app: '^1.0.0' },
			}),
			'packages/leaf/package.json': JSON.stringify({
				name: 'leaf',
				version: '1.0.0',
			}),
		}, ['--initial-branch=peers']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', peerRemote.path]);
		const result = await gitPublish(fixture.getPath('packages/app'));
		expect('exitCode' in result).toBe(false);
		for (const name of ['app', 'core', 'leaf']) {
			expect(await peerRemote.git('rev-parse', [`npm/peers-${name}`])).toMatch(/^[0-9a-f]{40}$/);
		}
	});

	test('publishes plain-range internal peers in pnpm workspaces', async () => {
		await using peerRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
			}),
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			'pnpm-lock.yaml': '',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				peerDependencies: { core: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		}, ['--initial-branch=pnpm-peer']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', peerRemote.path]);
		const result = await gitPublish(fixture.getPath('packages/app'));
		expect('exitCode' in result).toBe(false);
		expect(await peerRemote.git('rev-parse', ['npm/pnpm-peer-core'])).toMatch(/^[0-9a-f]{40}$/);
	});

	test('validates mismatched peers already selected for publication', async () => {
		await using peerRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'root',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				peerDependencies: { core: '^2.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		}, ['--initial-branch=selected-peer']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', peerRemote.path]);
		const rejected = await gitPublish(fixture.path, ['app', 'core']);
		expect(('exitCode' in rejected) && rejected.exitCode).toBe(1);
		expect(rejected.stdout).toContain('^2.0.0');
		expect(await peerRemote.git('for-each-ref')).toBe('');
		const external = await gitPublish(fixture.path, ['app']);
		expect('exitCode' in external).toBe(false);
		const branches = await peerRemote.git('branch', ['--list']);
		expect(branches).not.toContain('npm/selected-peer-core');
	});

	for (const [version, range, accepted] of [
		['1.1.0-beta.1', '^1.0.0', false],
		['1.0.0-beta.3', '*', true],
	] as const) {
		test(`validates prerelease ${version} against peer range ${range}`, async () => {
			await using peerRemote = await createGitFixture(undefined, ['--bare']);
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'root',
					private: true,
					workspaces: ['packages/*'],
				}),
				'package-lock.json': '{}',
				'packages/app/package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					peerDependencies: { core: range },
				}),
				'packages/core/package.json': JSON.stringify({
					name: 'core',
					version,
				}),
			}, ['--initial-branch=prerelease']);
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', peerRemote.path]);
			const result = await gitPublish(fixture.path, ['app', 'core']);
			expect('exitCode' in result).toBe(!accepted);
			if (!accepted) {
				expect(result.stdout).toContain(range);
				expect(await peerRemote.git('for-each-ref')).toBe('');
			}
		});
	}

	test('allows a pack hook to remove an internal peer', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('removed-peer', remote.path, {
			peerSpecification: 'workspace:*',
		});
		await using commands = await createFixture({
			npm: `#!/bin/sh
if [ "$1" = pack ] && [ -f package.json ]; then
  "${process.execPath}" -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json")); if (p.peerDependencies) { delete p.peerDependencies["@test/core"]; fs.writeFileSync("package.json", JSON.stringify(p)); }'
fi
exec "${path.join(path.dirname(process.execPath), 'npm')}" "$@"
`,
		});
		await fs.chmod(commands.getPath('npm'), 0o755);
		const result = await gitPublish(fixture.getPath('packages/adapter'), [], {
			PATH: `${commands.path}${path.delimiter}${process.env.PATH}`,
		});
		expect('exitCode' in result).toBe(false);
		const manifest = JSON.parse(await remote.git('show', ['npm/removed-peer-@test/adapter:package.json']));
		expect(manifest.peerDependencies?.['@test/core']).toBeUndefined();
	});

	test('rejects a packed internal peer range mismatch before pushing', async () => {
		await using peerRemote = await createGitFixture(undefined, ['--bare']);
		await using fixture = await createChainWorkspace('peer-mismatch', peerRemote.path, {
			peerSpecification: 'workspace:*',
		});
		await using commands = await createFixture({
			npm: `#!/bin/sh
if [ "$1" = pack ] && [ -f package.json ]; then
  "${process.execPath}" -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json")); if (p.peerDependencies) { p.peerDependencies["@test/core"] = "^2.0.0"; fs.writeFileSync("package.json", JSON.stringify(p)); }'
fi
exec "${path.join(path.dirname(process.execPath), 'npm')}" "$@"
`,
		});
		await fs.chmod(commands.getPath('npm'), 0o755);
		const result = await gitPublish(fixture.getPath('packages/adapter'), [], {
			PATH: `${commands.path}${path.delimiter}${process.env.PATH}`,
		});
		expect(('exitCode' in result) && result.exitCode).toBe(1);
		expect(result.stdout).toContain('@test/adapter');
		expect(result.stdout).toContain('@test/core');
		expect(result.stdout).toContain('^2.0.0');
		expect(result.stdout).toContain('0.0.0');
		expect(await peerRemote.git('for-each-ref')).toBe('');
	});

	test('rejects multiple push URLs', async () => {
		const branchName = 'test-workspace-push-urls';
		await using firstPushFixture = await createGitFixture(undefined, ['--bare']);
		const { git: firstRemoteGit } = firstPushFixture;
		await using secondPushFixture = await createGitFixture(undefined, ['--bare']);
		const { git: secondRemoteGit } = secondPushFixture;
		await using fixture = await createChainWorkspace(branchName, firstPushFixture.path);
		const { git } = fixture;
		await git('config', ['--add', 'remote.origin.pushurl', firstPushFixture.path]);
		await git('config', ['--add', 'remote.origin.pushurl', secondPushFixture.path]);

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toContain('requires exactly one push URL');
		expect(await firstRemoteGit('for-each-ref')).toBe('');
		expect(await secondRemoteGit('for-each-ref')).toBe('');
	});

	test('uses the push destination tip for --fresh leases', async () => {
		await using fetchRemoteFixture = await createGitFixture(undefined, ['--bare']);
		await using pushRemoteFixture = await createGitFixture(undefined, ['--bare']);
		const { git: pushRemoteGit } = pushRemoteFixture;
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}, null, 2),
			'package-lock.json': '{}',
			packages: {
				adapter: {
					'package.json': JSON.stringify({
						name: '@test/adapter',
						version: '0.0.0',
					}, null, 2),
					'index.js': 'module.exports = 1;',
				},
			},
		}, ['--initial-branch=test-workspace-fresh-push-url']);
		const { git } = fixture;
		await git('add', ['.']);
		await git('commit', ['-m', 'Initial commit']);
		await git('remote', ['add', 'origin', fetchRemoteFixture.path]);
		await git('config', ['remote.origin.pushurl', pushRemoteFixture.path]);
		await git('push', [pushRemoteFixture.path, 'HEAD:preview']);

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'), ['--branch', 'preview', '--fresh']);

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(await pushRemoteGit('show', ['preview:package.json'])).toContain('@test/adapter');
	});

	test('isolates packages from sibling lifecycle mutations', async () => {
		await using isolatedRemoteFixture = await createGitFixture(undefined, ['--bare']);
		const { git: isolatedRemoteGit } = isolatedRemoteFixture;
		await using fixture = await createChainWorkspace('test-workspace-pack-isolation', isolatedRemoteFixture.path, {
			corePrepack: 'node -e "require(\'node:fs\').writeFileSync(\'../broker/index.js\', \'module.exports = 2;\')"',
		});

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(await isolatedRemoteGit('show', ['npm/test-workspace-pack-isolation-@test/broker:index.js'])).toBe('module.exports = { core: require("@test/core") };');
	});

	test('does not update any package branch when an atomic push is rejected', async () => {
		const branchName = 'test-workspace-atomic-rejection';
		await using rejectedRemoteFixture = await createGitFixture(undefined, ['--bare']);
		const { git: rejectedRemoteGit } = rejectedRemoteFixture;
		const hookPath = path.join(rejectedRemoteFixture.path, 'hooks/pre-receive');
		await fs.writeFile(hookPath, `#!/bin/sh
		while read _ _ ref; do
			if [ "$ref" = "refs/heads/npm/${branchName}-@test/adapter" ]; then
				echo 'Adapter publication is rejected by this test hook' >&2
				exit 1
			fi
		done
`);
		await fs.chmod(hookPath, 0o755);
		await using fixture = await createChainWorkspace(branchName, rejectedRemoteFixture.path);

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stdout).toContain('Adapter publication is rejected by this test hook');
		expect(await rejectedRemoteGit('for-each-ref')).toBe('');
	});

	test('uses the default workspace template and installs the selected package when pnpm allows Git subdependencies', async () => {
		const branchName = 'test-workspace-acceptance';
		const remoteUrl = `git@example.test:${remoteFixture.path}`;
		const packageManagerRemoteUrl = `git+ssh://git@example.test${remoteFixture.path}`;
		await using commandsFixture = await createFixture(async (fixture) => {
			await fixture.writeFile('ssh', `#!/bin/sh
shift
exec sh -c "$*"
`);
			await fixture.writeFile('upload-pack', `#!/bin/sh
			if [ "$1" = "-G" ]; then
				exit 0
			fi
			exec git-upload-pack '${remoteFixture.path}'
`);
			await fs.chmod(fixture.getPath('ssh'), 0o755);
			await fs.chmod(fixture.getPath('upload-pack'), 0o755);
		});
		await using fixture = await createChainWorkspace(branchName, remoteUrl);
		const { git } = fixture;
		await git('config', ['core.sshCommand', commandsFixture.getPath('ssh')]);
		await git('config', ['ssh.variant', 'simple']);

		const adapterPath = path.join(fixture.path, 'packages/adapter');
		const gitPublishProcess = await gitPublish(adapterPath);
		expect('exitCode' in gitPublishProcess).toBe(false);

		const branches = {
			core: `npm/${branchName}-@test/core`,
			broker: `npm/${branchName}-@test/broker`,
			adapter: `npm/${branchName}-@test/adapter`,
		};
		const shas = {
			core: await remoteGit('rev-parse', [branches.core]),
			broker: await remoteGit('rev-parse', [branches.broker]),
			adapter: await remoteGit('rev-parse', [branches.adapter]),
		};
		for (const sha of Object.values(shas)) {
			expect(sha).toMatch(/^[0-9a-f]{40}$/);
		}
		for (const [name, branch] of Object.entries(branches)) {
			const manifest = JSON.parse(await remoteGit('show', [`${branch}:package.json`]));
			expect(manifest.name).toBe(`@test/${name}`);
		}

		const brokerManifest = JSON.parse(await remoteGit('show', [`${branches.broker}:package.json`]));
		expect(brokerManifest.dependencies['@test/core']).toBe(`${packageManagerRemoteUrl}#${shas.core}`);
		const adapterManifest = JSON.parse(await remoteGit('show', [`${branches.adapter}:package.json`]));
		expect(adapterManifest.dependencies['@test/broker']).toBe(`${packageManagerRemoteUrl}#${shas.broker}`);

		const adapterSpecifier = `${packageManagerRemoteUrl}#${shas.adapter}`;
		expect(gitPublishProcess.stdout).toContain(`npm install '${adapterSpecifier}'`);

		await using consumerFixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-consumer',
				version: '1.0.0',
				dependencies: {
					'@test/adapter': adapterSpecifier,
				},
			}),
		});
		await spawn('pnpm', ['install', '--ignore-scripts'], {
			cwd: consumerFixture.path,
			env: {
				PATH: process.env.PATH,
				GIT_SSH_COMMAND: commandsFixture.getPath('upload-pack'),
				// pnpm blocks Git dependencies of Git dependencies unless the consumer opts in.
				PNPM_CONFIG_BLOCK_EXOTIC_SUBDEPS: 'false',
			},
		});

		const resolved = await spawn('node', ['-e', 'console.log(require("@test/adapter").broker.core.core)'], {
			cwd: consumerFixture.path,
		});
		expect(resolved.stdout).toBe('1');

		const lockfile = await consumerFixture.readFile('pnpm-lock.yaml', 'utf8');
		expect(lockfile).not.toContain('registry.npmjs.org');
		for (const sha of Object.values(shas)) {
			expect(lockfile).toContain(sha);
		}
	});
});
