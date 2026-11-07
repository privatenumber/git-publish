import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { describe, expect, test } from 'manten';
import { createFixture } from 'fs-fixture';
import tarFs from 'tar-fs';
import {
	preparePackagePublication, toInstallSpecifier,
} from '../../src/package-publication/prepare.ts';
import { validatePackedWorkspaceDependencies } from '../../src/package-publication/validate.ts';
import { createGitFixture } from '../utils/create-git.ts';

describe('Package publication', () => {
	test('rejects unresolved workspace specifications in packed dependency fields', () => {
		for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
			expect(() => validatePackedWorkspaceDependencies('app', { [field]: { core: 'workspace:*' } }))
				.toThrow(`Package "app" has unresolved ${field} "core": "workspace:*".`);
		}
		validatePackedWorkspaceDependencies('app', { dependencies: { core: '^1.0.0' } });
	});
	test('omits query strings from HTTP and Git install URLs', () => {
		for (const scheme of ['http', 'https', 'git', 'git+https']) {
			expect(toInstallSpecifier(`${scheme}://host/repo.git?access_token=secret`, 'abc'))
				.toBe(`git+${scheme.replace(/^git\+/, '')}://host/repo.git#abc`);
		}
	});
	test('removes SSH passwords from install specifiers', () => {
		expect(toInstallSpecifier('ssh://git:secret@example.test/repo.git', 'abc'))
			.toBe('git+ssh://git@example.test/repo.git#abc');
	});

	test('omits SSH query credentials from install specifiers', () => {
		expect(toInstallSpecifier('ssh://git@host/repo.git?access_token=secret', 'abc'))
			.toBe('git+ssh://git@host/repo.git#abc');
	});

	test('treats Windows drive paths as local Git URLs', () => {
		for (const url of [String.raw`C:\git\repo.git`, 'C:/git/repo.git']) {
			expect(toInstallSpecifier(url, 'abc')).toBe('git+file:///C:/git/repo.git#abc');
		}
	});
	test('preserves relative and absolute SCP paths in install specifiers', () => {
		expect(toInstallSpecifier('git@host:repos/repo.git', 'abc'))
			.toBe('git+ssh://git@host/~/repos/repo.git#abc');
		expect(toInstallSpecifier('git@host:/srv/repo.git', 'abc'))
			.toBe('git+ssh://git@host/srv/repo.git#abc');
		for (const host of ['github.com', 'gitlab.com', 'bitbucket.org']) {
			expect(toInstallSpecifier(`git@${host}:owner/repo.git`, 'abc'))
				.toBe(`git+ssh://git@${host}/owner/repo.git#abc`);
		}
	});
	test('rewrites direct closure dependencies before committing the packed package', async () => {
		await using packageFixture = await createFixture({
			package: {
				'package.json': JSON.stringify({
					name: '@test/adapter',
					version: '1.0.0',
					scripts: {
						prepare: 'node prepare.js',
						prepack: 'node prepack.js',
						build: 'node build.js',
						preinstall: 'node preinstall.js',
						install: 'node install.js',
						postinstall: 'node postinstall.js',
						postpack: 'node postpack.js',
					},
					dependencies: {
						'core-alias': 'workspace:@test/core@*',
					},
					optionalDependencies: {
						'@test/optional': 'workspace:*',
					},
				}, null, 2),
				'index.js': 'module.exports = 1;',
			},
		});
		const tarballPath = packageFixture.getPath('package.tgz');
		await pipeline(
			tarFs.pack(packageFixture.getPath('package'), {
				map: (header) => {
					header.name = `package/${header.name}`;
					return header;
				},
			}),
			createGzip(),
			createWriteStream(tarballPath),
		);
		await using publishFixture = await createGitFixture();
		await publishFixture.git('commit', ['--allow-empty', '-m', 'Initial commit']);
		const preparation = await preparePackagePublication({
			packageName: '@test/adapter',
			sourceManifestPath: packageFixture.getPath('package/package.json'),
			packedTarball: tarballPath,
			publishWorktree: publishFixture.path,
			branch: 'npm/adapter',
			fetchUrl: '/remote.git',
			commitMessage: 'Published "@test/adapter" from "main" (1234567)',
			dependencyEdges: [
				{
					key: 'core-alias',
					field: 'dependencies',
					target: '@test/core',
				},
				{
					key: '@test/optional',
					field: 'optionalDependencies',
					target: '@test/optional',
				},
			],
			dependencyPublications: new Map([
				['@test/core', {
					packageName: '@test/core',
					branch: 'npm/core',
					commit: 'core-commit',
					installSpecifier: 'git+file:///remote.git#core-commit',
				}],
				['@test/optional', {
					packageName: '@test/optional',
					branch: 'npm/optional',
					commit: 'optional-commit',
					installSpecifier: 'git+file:///remote.git#optional-commit',
				}],
			]),
			gitOptions: {},
		});
		const manifest = JSON.parse(await fs.readFile(path.join(publishFixture.path, 'package.json'), 'utf8'));
		expect(manifest.dependencies).toStrictEqual({
			'core-alias': 'git+file:///remote.git#core-commit',
		});
		expect(manifest.optionalDependencies).toStrictEqual({
			'@test/optional': 'git+file:///remote.git#optional-commit',
		});
		expect(manifest.scripts).toStrictEqual({
			build: 'node build.js',
			preinstall: 'node preinstall.js',
			install: 'node install.js',
			postinstall: 'node postinstall.js',
		});
		expect(preparation.reusedExistingCommit).toBe(false);
		expect(preparation.publication).toStrictEqual({
			packageName: '@test/adapter',
			branch: 'npm/adapter',
			commit: await publishFixture.git('rev-parse', ['HEAD']),
			installSpecifier: `git+file://${path.resolve('/remote.git')}#${preparation.publication.commit}`,
		});
	});
});
