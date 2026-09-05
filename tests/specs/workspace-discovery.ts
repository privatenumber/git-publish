import fs from 'node:fs/promises';
import { describe, test, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { discoverWorkspacePackages, findWorkspacePackages } from '../../src/workspace-publication/discover.ts';

describe('Workspace discovery', () => {
	test('discovers npm workspace packages', async () => {
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
						name: '@test/a',
						version: '1.0.0',
					}),
				},
				b: {
					'package.json': JSON.stringify({
						name: '@test/b',
						version: '1.0.0',
						dependencies: {
							'@test/a': 'workspace:*',
						},
					}),
				},
			},
		});

		const workspace = await discoverWorkspacePackages(fixture.path, 'npm');

		expect(workspace.rootDir).toBe(await fs.realpath(fixture.path));
		expect(workspace.packageManager).toBe('npm');
		expect(workspace.packages.map(entry => entry.name).sort()).toStrictEqual(['@test/a', '@test/b']);
		const entry = workspace.packages.find(candidate => candidate.name === '@test/b');
		expect(entry?.relativeDir).toBe('packages/b');
		expect(entry?.packageJson.dependencies).toStrictEqual({ '@test/a': 'workspace:*' });
	});

	test('discovers pnpm workspace packages', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
			}),
			'pnpm-workspace.yaml': 'packages:\n  - \'packages/*\'\n',
			packages: {
				a: {
					'package.json': JSON.stringify({
						name: '@test/a',
						version: '1.0.0',
					}),
				},
			},
		});

		const workspace = await discoverWorkspacePackages(fixture.path, 'pnpm');

		expect(workspace.packages.map(entry => entry.name)).toStrictEqual(['@test/a']);
	});

	test('discovers bun workspace packages', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}),
			'bun.lock': '',
			packages: {
				a: {
					'package.json': JSON.stringify({
						name: '@test/a',
						version: '1.0.0',
					}),
				},
			},
		});

		const workspace = await discoverWorkspacePackages(fixture.path, 'bun');

		expect(workspace.packageManager).toBe('bun');
		expect(workspace.packages.map(entry => entry.name)).toStrictEqual(['@test/a']);
	});

	test('discovers yarn workspace packages', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}),
			'yarn.lock': '',
			packages: {
				a: {
					'package.json': JSON.stringify({
						name: '@test/a',
						version: '1.0.0',
					}),
				},
			},
		});

		const workspace = await discoverWorkspacePackages(fixture.path, 'yarn');

		expect(workspace.packageManager).toBe('yarn');
		expect(workspace.packages.map(entry => entry.name)).toStrictEqual(['@test/a']);
	});

	test('prefers the detected manager over stale lockfiles', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-monorepo',
				private: true,
				workspaces: ['packages/*'],
			}),
			'pnpm-workspace.yaml': 'packages:\n  - \'packages/*\'\n',
			'yarn.lock': '',
			packages: {
				a: {
					'package.json': JSON.stringify({
						name: '@test/a',
						version: '1.0.0',
					}),
				},
			},
		});

		const workspace = await discoverWorkspacePackages(fixture.path, 'pnpm');

		expect(workspace.packageManager).toBe('pnpm');
		expect(workspace.packages.map(entry => entry.name)).toStrictEqual(['@test/a']);
	});

	test('rejects package manager mismatches', async () => {
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
						name: '@test/a',
						version: '1.0.0',
					}),
				},
			},
		});

		let message = '';
		try {
			await discoverWorkspacePackages(fixture.path, 'pnpm');
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toContain('No pnpm workspace found');
	});

	test('rejects directories without a matching workspace', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}),
		});

		let message = '';
		try {
			await discoverWorkspacePackages(fixture.path, 'npm');
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toContain('No npm workspace found');
	});

	test('returns undefined for a package outside a workspace', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
			}),
		});

		expect(await findWorkspacePackages(fixture.path, 'npm')).toBeUndefined();
	});
});
