import path from 'node:path';
import fs from 'node:fs/promises';
import {
	describe, test, expect, onFinish,
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
			devDependencies: ['z', 'x'],
		})) {
			expect(Object.keys(manifest[field])).toStrictEqual(keys);
		}
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
					? { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' }
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
		const result = await gitPublish(fixture.path);
		expect('exitCode' in result).toBe(false);
		for (const name of ['core', 'broker', 'adapter']) {
			expect(await allRemote.git('rev-parse', [`npm/all-@test/${name}`])).toMatch(/^[0-9a-f]{40}$/);
		}
		const branches = await allRemote.git('branch', ['--list']);
		expect(branches).not.toContain('test-monorepo');
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
		expect(gitPublishProcess.stdout).not.toContain('Required workspace dependencies');
		expect(gitPublishProcess.stdout).toContain('Pushing 1 package');
	});

	test('groups required dependencies under the selected package publication', async () => {
		const branchName = 'test-workspace-progress';
		await using fixture = await createChainWorkspace(branchName, remoteFixture.path, {
			corePrepack: 'node -e "setTimeout(() => {}, 1100)"',
		});

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stdout).toContain(`Published "@test/adapter" from "${branchName}"`);
		expect(gitPublishProcess.stdout).toContain('Required workspace dependencies');
		expect(gitPublishProcess.stdout).toContain('@test/core');
		expect(gitPublishProcess.stdout).toMatch(/@test\/core[^\n]*\(\d+(?:\.\d+)?(?:ms|s)\)/);
		expect(gitPublishProcess.stdout).toContain('@test/broker');
		expect(gitPublishProcess.stdout).toContain('@test/adapter');
		expect(gitPublishProcess.stdout).toContain('Pushing 3 packages together');
		expect(gitPublishProcess.stdout).not.toContain('workspace closure');
		expect(gitPublishProcess.stdout.indexOf('→ Install command')).toBeGreaterThan(
			gitPublishProcess.stdout.lastIndexOf(`Published "@test/adapter" from "${branchName}"`),
		);
		expect(gitPublishProcess.stdout.split('→ Install command')).toHaveLength(2);
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
		expect(gitPublishProcess.stdout).toContain('→ Install command');
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
		await using secondPushFixture = await createGitFixture(undefined, ['--bare']);
		const { git: secondRemoteGit } = secondPushFixture;
		await using fixture = await createChainWorkspace(branchName, remoteFixture.path);
		const { git } = fixture;
		await git('config', ['--add', 'remote.origin.pushurl', remoteFixture.path]);
		await git('config', ['--add', 'remote.origin.pushurl', secondPushFixture.path]);

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
		expect(gitPublishProcess.stderr).toContain('requires exactly one push URL');
		expect(await remoteGit('for-each-ref')).toBe('');
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
		const packageManagerRemoteUrl = `git+ssh://git@example.test/${remoteFixture.path}`;
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
		expect(gitPublishProcess.stdout).toContain(`i '${adapterSpecifier}'`);

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
