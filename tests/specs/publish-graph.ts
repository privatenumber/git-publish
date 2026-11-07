import { describe, test, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import { discoverWorkspacePackages } from '../../src/workspace-publication/discover.ts';
import { satisfiesPackedPeer, satisfiesWorkspaceRange } from '../../src/workspace-publication/satisfies-range.ts';
import { planWorkspacePublication } from '../../src/workspace-publication/plan.ts';
import { createWorkspaceResult, formatWorkspaceResult } from '../../src/workspace-publication/output.ts';
import type { PackagePreparation } from '../../src/package-publication/prepare.ts';
import {
	createPublishGraph,
	findWorkspacePackageDirectory,
	selectWorkspacePackage,
} from '../../src/workspace-publication/graph.ts';

const discoverTestWorkspace = async (packages: Record<string, unknown>) => {
	await using fixture = await createFixture({
		'package.json': JSON.stringify({
			name: 'test-monorepo',
			private: true,
			workspaces: ['packages/*'],
		}),
		'package-lock.json': '{}',
		packages: Object.fromEntries(Object.entries(packages).map(([directory, manifest]) => [
			directory,
			{ 'package.json': JSON.stringify(manifest) },
		])),
	});
	return discoverWorkspacePackages(fixture.path, 'npm');
};

describe('Publication graph', () => {
	test('resolves file and link sibling paths as internal runtime and peer edges', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: 'app',
				version: '1.0.0',
				dependencies: { alias: 'file:../core' },
				peerDependencies: { other: 'link:../core' },
			},
			core: {
				name: 'core',
				version: '1.0.0',
			},
		});
		for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
			const graph = createPublishGraph(workspace, ['app'], {
				policy: {
					plainRanges: manager !== 'pnpm',
					plainPeers: true,
				},
			});
			expect(graph.nodes.find(node => node.key === 'app')!.dependencies[0]?.target).toBe('core');
			expect(graph.peers[0]?.target).toBe('core');
		}
	});
	test('includes prereleases for star and empty ranges but not x', () => {
		expect(['', '*', 'x', 'X'].map(range => satisfiesWorkspaceRange('1.0.0-beta.3', range)))
			.toStrictEqual([true, true, false, false]);
	});
	test('uses the optional edge when both dependency fields contain the same key', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: 'app',
				version: '1.0.0',
				dependencies: { core: '^1.0.0' },
				optionalDependencies: { core: '^1.0.0' },
			},
			core: {
				name: 'core',
				version: '1.0.0',
			},
		});
		const graph = createPublishGraph(workspace, ['app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.find(node => node.key === 'app')!.dependencies).toStrictEqual([
			{
				key: 'core',
				field: 'optionalDependencies',
				target: 'core',
			},
		]);
	});
	test('reads Yarn transparent workspace configuration at the workspace root', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				private: true,
				workspaces: ['packages/*'],
			}),
			'yarn.lock': '',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				dependencies: { core: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		});
		const options = {
			cwd: fixture.path,
			gitRootPath: fixture.path,
			sourceName: 'main',
			sourceCommitId: undefined,
			packageManager: 'yarn' as const,
			force: false,
			selection: ['app'],
		};
		expect((await planWorkspacePublication(options))!.nodes.map(node => node.key)).toStrictEqual(['core', 'app']);
		await fixture.writeFile('.yarnrc.yml', 'enableTransparentWorkspaces: false\n');
		expect((await planWorkspacePublication(options))!.nodes.map(node => node.key)).toStrictEqual(['app']);
		await fixture.writeFile('.yarnrc.yml', 'enableTransparentWorkspaces: true\n');
		expect((await planWorkspacePublication(options))!.nodes.map(node => node.key)).toStrictEqual(['core', 'app']);
	});
	test('uses the Yarn environment setting over workspace configuration', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				private: true,
				workspaces: ['packages/*'],
			}),
			'yarn.lock': '',
			'.yarnrc.yml': 'enableTransparentWorkspaces: true\n',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				dependencies: { core: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		});
		const script = `import { planWorkspacePublication } from ${JSON.stringify(new URL('../../src/workspace-publication/plan.ts', import.meta.url).href)};
		const plan = await planWorkspacePublication({ cwd: ${JSON.stringify(fixture.path)}, gitRootPath: ${JSON.stringify(fixture.path)}, sourceName: 'main', packageManager: 'yarn', force: false, selection: ['app'] });
		console.log(JSON.stringify(plan.nodes.map(node => node.key)));`;
		for (const value of ['false', '0']) {
			const { stdout } = await spawn(process.execPath, ['--input-type=module', '-e', script], {
				env: { YARN_ENABLE_TRANSPARENT_WORKSPACES: value },
			});
			expect(JSON.parse(stdout)).toStrictEqual(['app']);
		}
		await fixture.writeFile('.yarnrc.yml', 'enableTransparentWorkspaces: false\n');
		const { stdout } = await spawn(process.execPath, ['--input-type=module', '-e', script], {
			env: { YARN_ENABLE_TRANSPARENT_WORKSPACES: 'true' },
		});
		expect(JSON.parse(stdout)).toStrictEqual(['core', 'app']);
	});
	test('resolves plain Yarn peers when transparent workspaces are disabled', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				private: true,
				workspaces: ['packages/*'],
			}),
			'yarn.lock': '',
			'.yarnrc.yml': 'enableTransparentWorkspaces: false\n',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				peerDependencies: { core: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		});
		const plan = await planWorkspacePublication({
			cwd: fixture.path,
			gitRootPath: fixture.path,
			sourceName: 'main',
			sourceCommitId: undefined,
			packageManager: 'yarn',
			force: false,
			selection: ['app'],
		});
		expect(plan!.nodes.map(node => node.key)).toStrictEqual(['app', 'core']);
	});
	test('links pnpm plain ranges when workspace linking is enabled', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ private: true }),
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			'packages/app/package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				dependencies: { core: '^1.0.0' },
			}),
			'packages/core/package.json': JSON.stringify({
				name: 'core',
				version: '1.0.0',
			}),
		});
		const options = {
			cwd: fixture.path,
			gitRootPath: fixture.path,
			sourceName: 'main',
			sourceCommitId: undefined,
			packageManager: 'pnpm' as const,
			force: false,
			selection: ['app'],
		};
		for (const config of ['linkWorkspacePackages: true', 'link-workspace-packages: true']) {
			await fixture.writeFile('pnpm-workspace.yaml', `packages:\n  - packages/*\n${config}\n`);
			expect((await planWorkspacePublication(options))!.nodes.map(node => node.key)).toStrictEqual(['core', 'app']);
		}
		await fixture.writeFile('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
		await fixture.writeFile('.npmrc', 'link-workspace-packages=true\n');
		expect((await planWorkspacePublication(options))!.nodes.map(node => node.key)).toStrictEqual(['core', 'app']);
	});
	test('reports aliased peer edges in each install set', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: 'app',
				version: '1.0.0',
				peerDependencies: { alias: 'workspace:core@*' },
				peerDependenciesMeta: { alias: { optional: true } },
			},
			core: {
				name: 'core',
				version: '1.0.0',
			},
		});
		const graph = createPublishGraph(workspace, ['app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		const nodes = graph.nodes.map(node => ({
			...node,
			branch: `npm/${node.key}`,
		}));
		const preparations = new Map<string, PackagePreparation>(nodes.map(node => [node.key, {
			publication: {
				packageName: node.key,
				branch: node.branch,
				commit: 'abc',
				installSpecifier: 'git+https://example.test/repo#abc',
			},
			files: [],
			unpublishedFilesFieldEntries: [],
			reusedExistingCommit: false,
			version: '1.0.0',
			peerDependencies: {},
		}]));
		const plan = {
			roots: ['app'],
			publishAll: false,
			nodes,
			peers: graph.peers,
		};
		const result = createWorkspaceResult(plan, preparations, 'main', 'abc');
		expect(result.aliases).toStrictEqual({ app: { alias: 'core' } });
		expect(result.installSets.app).toStrictEqual({
			required: ['app'],
			optional: ['core'],
		});
		const optionalOutput = formatWorkspaceResult(result, 'npm', 'https://example.test/repo');
		expect(optionalOutput).toContain("Optional peers alias: install with npm install 'alias@git+https://example.test/repo#abc'");
		expect(optionalOutput).not.toContain('Optional workspace dependencies core install transitively');
		const app = nodes.find(node => node.key === 'app')!;
		graph.peers[0]!.optional = false;
		app.dependencies.push({
			key: 'runtime',
			field: 'dependencies',
			target: 'core',
		});
		const requiredResult = createWorkspaceResult(plan, preparations, 'main', 'abc');
		expect(requiredResult.aliases).toStrictEqual({
			app: {
				runtime: 'core',
				alias: 'core',
			},
		});
		for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
			const output = formatWorkspaceResult(requiredResult, manager, 'https://example.test/repo');
			expect(output).toContain('runtime@git+https://example.test/repo#abc');
			expect(output).toContain('alias@git+https://example.test/repo#abc');
			expect(output).not.toContain('core@git+https://example.test/repo#abc');
		}
		app.dependencies.push({
			key: 'core',
			field: 'dependencies',
			target: 'core',
		});
		const output = formatWorkspaceResult(createWorkspaceResult(plan, preparations, 'main', 'abc'), 'yarn', 'https://example.test/repo');
		expect(output).toContain('core@git+https://example.test/repo#abc');
	});

	test('installs the required closure of an optional peer', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: 'app',
				version: '1.0.0',
				peerDependencies: { adapter: 'workspace:*' },
				peerDependenciesMeta: { adapter: { optional: true } },
			},
			adapter: {
				name: 'adapter',
				version: '1.0.0',
				peerDependencies: { core: 'workspace:*' },
			},
			core: {
				name: 'core',
				version: '1.0.0',
			},
		});
		const graph = createPublishGraph(workspace, ['app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		const nodes = graph.nodes.map(node => ({
			...node,
			branch: `npm/${node.key}`,
		}));
		const preparations = new Map<string, PackagePreparation>(nodes.map(node => [node.key, {
			publication: {
				packageName: node.key,
				branch: node.branch,
				commit: node.key,
				installSpecifier: `git+https://example.test/repo#${node.key}`,
			},
			files: [],
			unpublishedFilesFieldEntries: [],
			reusedExistingCommit: false,
			version: '1.0.0',
			peerDependencies: {},
		}]));
		const result = createWorkspaceResult({
			roots: ['app'],
			publishAll: false,
			nodes,
			peers: graph.peers,
		}, preparations, 'main', 'abc');
		const output = formatWorkspaceResult(result, 'npm', 'https://example.test/repo');
		expect(output).toContain("Optional peers adapter: install with npm install 'git+https://example.test/repo#adapter' 'git+https://example.test/repo#core'");
		expect(output).not.toContain('Optional workspace dependencies core install transitively');
	});

	test('reports optional peers of optional dependencies', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: 'app',
				version: '1.0.0',
				optionalDependencies: { b: 'workspace:*' },
			},
			b: {
				name: 'b',
				version: '1.0.0',
				peerDependencies: { c: 'workspace:*' },
				peerDependenciesMeta: { c: { optional: true } },
			},
			c: {
				name: 'c',
				version: '1.0.0',
			},
		});
		const graph = createPublishGraph(workspace, ['app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		const nodes = graph.nodes.map(node => ({
			...node,
			branch: `npm/${node.key}`,
		}));
		const preparations = new Map<string, PackagePreparation>(nodes.map(node => [node.key, {
			publication: {
				packageName: node.key,
				branch: node.branch,
				commit: node.key,
				installSpecifier: `git+https://example.test/repo#${node.key}`,
			},
			files: [],
			unpublishedFilesFieldEntries: [],
			reusedExistingCommit: false,
			version: '1.0.0',
			peerDependencies: {},
		}]));
		const result = createWorkspaceResult({
			roots: ['app'],
			publishAll: false,
			nodes,
			peers: graph.peers,
		}, preparations, 'main', 'abc');
		const output = formatWorkspaceResult(result, 'npm', 'https://example.test/repo');
		expect(output).toContain('Optional workspace dependencies b install transitively');
		expect(output).toContain("Optional peers c: install with npm install 'git+https://example.test/repo#c'");
	});

	test('rejects an aliased workspace range that does not match its target', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: 'app',
				version: '1.0.0',
				dependencies: { alias: 'workspace:core@^2.0.0' },
			},
			core: {
				name: 'core',
				version: '1.0.0',
			},
		});
		expect(() => createPublishGraph(workspace, ['app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		})).toThrow('^2.0.0');
	});
	test('validates packed peer ranges, including pnpm aliases', () => {
		expect(satisfiesPackedPeer('^1.0.0', 'core', '1.2.0')).toBe(true);
		expect(satisfiesPackedPeer('npm:core@*', 'core', '1.0.0')).toBe(true);
		expect(satisfiesPackedPeer('npm:@scope/core@^1.0.0', '@scope/core', '1.0.0')).toBe(true);
		expect(satisfiesPackedPeer('npm:other@*', 'core', '1.0.0')).toBe(false);
		// pnpm 10.29.3 packs an installed `workspace:core@*` peer this way
		expect(satisfiesPackedPeer('1.0.0core@*', 'core', '1.0.0')).toBe(false);
	});

	test('does not resolve a prerelease runtime dependency through a stable range', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: 'app',
				version: '1.0.0',
				dependencies: { core: '^1.0.0' },
			},
			core: {
				name: 'core',
				version: '1.1.0-beta.1',
			},
		});
		expect(createPublishGraph(workspace, ['app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		}).nodes.map(node => node.key)).toStrictEqual(['app']);
	});
	test('selects the dependency chain in dependency order', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			packages: {
				'session-broker-core': {
					'package.json': JSON.stringify({
						name: '@hunk/session-broker-core',
						version: '0.0.0',
					}),
				},
				'session-broker': {
					'package.json': JSON.stringify({
						name: '@hunk/session-broker',
						version: '0.0.0',
						dependencies: {
							'@hunk/session-broker-core': 'workspace:*',
						},
					}),
				},
				'session-broker-bun': {
					'package.json': JSON.stringify({
						name: '@hunk/session-broker-bun',
						version: '0.0.0',
						dependencies: {
							'@hunk/session-broker': 'workspace:*',
						},
					}),
				},
			},
		});
		const workspace = await discoverWorkspacePackages(fixture.path, 'npm');
		const graph = createPublishGraph(workspace, ['@hunk/session-broker-bun'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});

		expect(graph.nodes.map(node => node.key)).toStrictEqual([
			'@hunk/session-broker-core',
			'@hunk/session-broker',
			'@hunk/session-broker-bun',
		]);
		const broker = graph.nodes.find(node => node.key === '@hunk/session-broker');
		expect(broker?.dependencies).toStrictEqual([{
			key: '@hunk/session-broker-core',
			field: 'dependencies',
			target: '@hunk/session-broker-core',
		}]);
		expect(graph.peers).toStrictEqual([]);
	});

	test('selects a leaf package alone', async () => {
		const workspace = await discoverTestWorkspace({
			core: {
				name: '@test/core',
				version: '1.0.0',
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				dependencies: {
					'@test/core': 'workspace:*',
				},
			},
		});

		expect(createPublishGraph(workspace, ['@test/core'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		}).nodes.map(node => node.key)).toStrictEqual(['@test/core']);
	});

	test('preserves diamond edges without duplicating shared dependencies', async () => {
		const workspace = await discoverTestWorkspace({
			core: {
				name: '@test/core',
				version: '1.0.0',
			},
			a: {
				name: '@test/a',
				version: '1.0.0',
				dependencies: {
					'@test/core': 'workspace:*',
				},
			},
			b: {
				name: '@test/b',
				version: '1.0.0',
				dependencies: {
					'@test/core': 'workspace:*',
				},
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				dependencies: {
					'@test/a': 'workspace:*',
					'@test/b': 'workspace:*',
				},
			},
		});

		const graph = createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/core', '@test/a', '@test/b', '@test/app']);
		const app = graph.nodes.find(node => node.key === '@test/app');
		expect(app?.dependencies.map(edge => edge.target)).toStrictEqual(['@test/a', '@test/b']);
	});

	test('traverses optional dependencies', async () => {
		const workspace = await discoverTestWorkspace({
			core: {
				name: '@test/core',
				version: '1.0.0',
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				optionalDependencies: {
					'@test/core': 'workspace:*',
				},
			},
		});

		const graph = createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/core', '@test/app']);
		const app = graph.nodes.find(node => node.key === '@test/app');
		expect(app?.dependencies).toStrictEqual([{
			key: '@test/core',
			field: 'optionalDependencies',
			target: '@test/core',
		}]);
	});

	test('ignores development dependencies', async () => {
		const workspace = await discoverTestWorkspace({
			core: {
				name: '@test/core',
				version: '1.0.0',
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				devDependencies: {
					'@test/core': 'workspace:*',
				},
			},
		});

		expect(createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		}).nodes.map(node => node.key)).toStrictEqual(['@test/app']);
	});

	test('traverses internal peers', async () => {
		const workspace = await discoverTestWorkspace({
			core: {
				name: '@test/core',
				version: '1.0.0',
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				peerDependencies: {
					'@test/core': '^1.0.0',
				},
			},
		});

		const graph = createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/app', '@test/core']);
		expect(graph.nodes.map(node => node.role)).toStrictEqual(['root', 'peer']);
		expect(graph.peers).toStrictEqual([{
			from: '@test/app',
			key: '@test/core',
			specification: '^1.0.0',
			optional: false,
			target: '@test/core',
		}]);
	});

	test('traverses aliased internal peers', async () => {
		const workspace = await discoverTestWorkspace({
			core: {
				name: '@test/core',
				version: '1.0.0',
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				peerDependencies: {
					'@test/alias': 'workspace:@test/core@*',
				},
			},
		});

		const graph = createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/app', '@test/core']);
		expect(graph.peers).toStrictEqual([{
			from: '@test/app',
			key: '@test/alias',
			specification: 'workspace:@test/core@*',
			optional: false,
			target: '@test/core',
		}]);
	});

	test('traverses relative internal peers', async () => {
		const workspace = await discoverTestWorkspace({
			core: {
				name: '@test/core',
				version: '1.0.0',
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				peerDependencies: {
					'@test/core': 'workspace:../core',
				},
			},
		});

		const graph = createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/app', '@test/core']);
		expect(graph.peers).toStrictEqual([{
			from: '@test/app',
			key: '@test/core',
			specification: 'workspace:../core',
			optional: false,
			target: '@test/core',
		}]);
	});

	test('diagnoses unresolvable peers without failing', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: '@test/app',
				version: '1.0.0',
				peerDependencies: {
					'@test/ghost': 'workspace:*',
				},
			},
		});

		const graph = createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/app']);
		expect(graph.peers).toStrictEqual([{
			from: '@test/app',
			key: '@test/ghost',
			specification: 'workspace:*',
			optional: false,
			target: undefined,
		}]);
	});

	test('resolves aliases separately from entry keys', async () => {
		const workspace = await discoverTestWorkspace({
			actual: {
				name: '@test/actual',
				version: '1.2.3',
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				dependencies: {
					'@test/alias': 'workspace:@test/actual@^1.0.0',
				},
			},
		});

		const graph = createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/actual', '@test/app']);
		const app = graph.nodes.find(node => node.key === '@test/app');
		expect(app?.dependencies).toStrictEqual([{
			key: '@test/alias',
			field: 'dependencies',
			target: '@test/actual',
		}]);
	});

	test('resolves relative paths', async () => {
		const workspace = await discoverTestWorkspace({
			core: {
				name: '@test/core',
				version: '1.0.0',
			},
			app: {
				name: '@test/app',
				version: '1.0.0',
				dependencies: {
					'@test/core': 'workspace:../core',
				},
			},
		});

		const graph = createPublishGraph(workspace, ['@test/app'], {
			policy: {
				plainRanges: true,
				plainPeers: true,
			},
		});
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/core', '@test/app']);
		const app = graph.nodes.find(node => node.key === '@test/app');
		expect(app?.dependencies[0]?.target).toBe('@test/core');
	});

	for (const range of ['*', '^', '~', '^1.2.3', '~1.2.3', '1.2.3', '>=1.2.3', '^1.2.3 || ^2.0.0', '1.2.x']) {
		test(`resolves workspace range ${JSON.stringify(range)}`, async () => {
			const workspace = await discoverTestWorkspace({
				core: {
					name: '@test/core',
					version: '1.2.3',
				},
				app: {
					name: '@test/app',
					version: '1.0.0',
					dependencies: {
						'@test/core': `workspace:${range}`,
					},
				},
			});

			expect(createPublishGraph(workspace, ['@test/app'], {
				policy: {
					plainRanges: true,
					plainPeers: true,
				},
			}).nodes.map(node => node.key)).toStrictEqual(['@test/core', '@test/app']);
		});
	}

	for (const specification of ['workspace:', 'workspace:alias@', 'workspace:@*']) {
		test(`rejects invalid workspace specification ${JSON.stringify(specification)}`, async () => {
			const workspace = await discoverTestWorkspace({
				core: {
					name: '@test/core',
					version: '1.0.0',
				},
				app: {
					name: '@test/app',
					version: '1.0.0',
					dependencies: {
						'@test/core': specification,
					},
				},
			});

			let message = '';
			try {
				createPublishGraph(workspace, ['@test/app'], {
					policy: {
						plainRanges: true,
						plainPeers: true,
					},
				});
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				message = (error as Error).message;
			}
			expect(message).toContain('Unsupported workspace specification');
		});
	}

	test('rejects unknown selected packages', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: '@test/app',
				version: '1.0.0',
			},
		});

		let message = '';
		try {
			selectWorkspacePackage(workspace, '@test/ghost');
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toContain('Unknown workspace package "@test/ghost"');
		expect(message).toContain('@test/app');
	});

	test('rejects duplicate package names', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			packages: {
				a: {
					'package.json': JSON.stringify({
						name: '@test/duplicate',
						version: '1.0.0',
					}),
				},
				b: {
					'package.json': JSON.stringify({
						name: '@test/duplicate',
						version: '2.0.0',
					}),
				},
			},
		});
		const workspace = await discoverWorkspacePackages(fixture.path, 'npm');

		let message = '';
		try {
			createPublishGraph(workspace, ['@test/duplicate'], {
				policy: {
					plainRanges: true,
					plainPeers: true,
				},
			});
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toContain('Duplicate workspace package name "@test/duplicate"');
	});

	test('rejects missing workspace targets', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: '@test/app',
				version: '1.0.0',
				dependencies: {
					'@test/ghost': 'workspace:*',
				},
			},
		});

		let message = '';
		try {
			createPublishGraph(workspace, ['@test/app'], {
				policy: {
					plainRanges: true,
					plainPeers: true,
				},
			});
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toContain('Unknown workspace package "@test/ghost"');
		expect(message).toContain('@test/app');
	});

	test('rejects unresolvable relative paths', async () => {
		const workspace = await discoverTestWorkspace({
			app: {
				name: '@test/app',
				version: '1.0.0',
				dependencies: {
					'@test/core': 'workspace:../missing',
				},
			},
		});

		let message = '';
		try {
			createPublishGraph(workspace, ['@test/app'], {
				policy: {
					plainRanges: true,
					plainPeers: true,
				},
			});
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toContain('does not resolve');
	});

	test('rejects dependency cycles', async () => {
		const workspace = await discoverTestWorkspace({
			a: {
				name: '@test/a',
				version: '1.0.0',
				dependencies: {
					'@test/b': 'workspace:*',
				},
			},
			b: {
				name: '@test/b',
				version: '1.0.0',
				dependencies: {
					'@test/a': 'workspace:*',
				},
			},
		});

		let message = '';
		try {
			createPublishGraph(workspace, ['@test/a'], {
				policy: {
					plainRanges: true,
					plainPeers: true,
				},
			});
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toContain('Dependency cycle detected');
		expect(message).toContain('@test/a -> @test/b -> @test/a');
	});

	test('finds the package containing the working directory', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}),
			'package-lock.json': '{}',
			packages: {
				core: {
					'package.json': JSON.stringify({
						name: '@test/core',
						version: '1.0.0',
					}),
				},
				app: {
					'package.json': JSON.stringify({
						name: '@test/app',
						version: '1.0.0',
					}),
				},
			},
		});
		const workspace = await discoverWorkspacePackages(fixture.path, 'npm');

		expect(findWorkspacePackageDirectory(workspace, fixture.getPath('packages/app'))?.name).toBe('@test/app');
		expect(findWorkspacePackageDirectory(workspace, fixture.getPath('packages/app/src'))?.name).toBe('@test/app');
		expect(findWorkspacePackageDirectory(workspace, fixture.path)).toBeUndefined();
	});
});
