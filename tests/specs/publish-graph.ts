import { describe, test, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { discoverWorkspacePackages } from '../../src/workspace-publication/discover.ts';
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
		const graph = createPublishGraph(workspace, '@hunk/session-broker-bun');

		expect(graph.selected).toBe('@hunk/session-broker-bun');
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

		expect(createPublishGraph(workspace, '@test/core').nodes.map(node => node.key)).toStrictEqual(['@test/core']);
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

		const graph = createPublishGraph(workspace, '@test/app');
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

		const graph = createPublishGraph(workspace, '@test/app');
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

		expect(createPublishGraph(workspace, '@test/app').nodes.map(node => node.key)).toStrictEqual(['@test/app']);
	});

	test('diagnoses internal peers without traversing them', async () => {
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

		const graph = createPublishGraph(workspace, '@test/app');
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/app']);
		expect(graph.peers).toStrictEqual([{
			from: '@test/app',
			key: '@test/core',
			specification: '^1.0.0',
			target: '@test/core',
		}]);
	});

	test('diagnoses aliased internal peers without traversing them', async () => {
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

		const graph = createPublishGraph(workspace, '@test/app');
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/app']);
		expect(graph.peers).toStrictEqual([{
			from: '@test/app',
			key: '@test/alias',
			specification: 'workspace:@test/core@*',
			target: '@test/core',
		}]);
	});

	test('diagnoses relative internal peers without traversing them', async () => {
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

		const graph = createPublishGraph(workspace, '@test/app');
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/app']);
		expect(graph.peers).toStrictEqual([{
			from: '@test/app',
			key: '@test/core',
			specification: 'workspace:../core',
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

		const graph = createPublishGraph(workspace, '@test/app');
		expect(graph.nodes.map(node => node.key)).toStrictEqual(['@test/app']);
		expect(graph.peers).toStrictEqual([{
			from: '@test/app',
			key: '@test/ghost',
			specification: 'workspace:*',
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

		const graph = createPublishGraph(workspace, '@test/app');
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

		const graph = createPublishGraph(workspace, '@test/app');
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

			expect(createPublishGraph(workspace, '@test/app').nodes.map(node => node.key)).toStrictEqual(['@test/core', '@test/app']);
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
				createPublishGraph(workspace, '@test/app');
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
			createPublishGraph(workspace, '@test/duplicate');
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
			createPublishGraph(workspace, '@test/app');
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
			createPublishGraph(workspace, '@test/app');
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
			createPublishGraph(workspace, '@test/a');
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
