import path from 'node:path';
import fs from 'node:fs/promises';
import {
	describe, test, expect, onFinish,
} from 'manten';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import { createGit, createGitFixture } from '../utils/create-git.ts';
import { gitPublish } from '../utils/git-publish.ts';

describe('Workspace publication', async () => {
	const remoteFixture = await createGitFixture(undefined, ['--bare']);
	onFinish(() => remoteFixture.rm());
	const { git: remoteGit } = remoteFixture;

	const createChainWorkspace = async (
		branchName: string,
		remote: string,
		{
			adapterSpecification = 'workspace:*',
			corePrepack,
			peerSpecification,
		}: {
			adapterSpecification?: string;
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

	test('warns when workspace peers are excluded from publication', async () => {
		const branchName = 'test-workspace-peer-diagnostic';
		await using fixture = await createChainWorkspace(branchName, remoteFixture.path, {
			peerSpecification: 'workspace:*',
		});

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect('exitCode' in gitPublishProcess).toBe(false);
		expect(gitPublishProcess.stderr).toContain('Internal workspace peer dependencies are not published');
		expect(gitPublishProcess.stderr).toContain('"@test/adapter" declares "@test/core": "workspace:*" resolves to "@test/core"');
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
				exit 1
			fi
		done
`);
		await fs.chmod(hookPath, 0o755);
		await using fixture = await createChainWorkspace(branchName, rejectedRemoteFixture.path);

		const gitPublishProcess = await gitPublish(path.join(fixture.path, 'packages/adapter'));

		expect(('exitCode' in gitPublishProcess) && gitPublishProcess.exitCode).toBe(1);
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
