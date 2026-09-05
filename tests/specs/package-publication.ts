import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { describe, expect, test } from 'manten';
import { createFixture } from 'fs-fixture';
import tarFs from 'tar-fs';
import { preparePackagePublication } from '../../src/package-publication/prepare.ts';
import { createGitFixture } from '../utils/create-git.ts';

describe('Package publication', () => {
	test('rewrites direct closure dependencies before committing the packed package', async () => {
		await using packageFixture = await createFixture({
			package: {
				'package.json': JSON.stringify({
					name: '@test/adapter',
					version: '1.0.0',
					scripts: {
						prepare: 'node prepare.js',
						prepack: 'node prepack.js',
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
			packedTarball: tarballPath,
			publishWorktree: publishFixture.path,
			branch: 'npm/adapter',
			fetchUrl: '/remote.git',
			sourceName: 'main',
			sourceCommit: '1234567',
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
					refspec: 'core-commit:refs/heads/npm/core',
				}],
				['@test/optional', {
					packageName: '@test/optional',
					branch: 'npm/optional',
					commit: 'optional-commit',
					installSpecifier: 'git+file:///remote.git#optional-commit',
					refspec: 'optional-commit:refs/heads/npm/optional',
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
		expect(manifest.scripts).toStrictEqual({ postpack: 'node postpack.js' });
		expect(preparation.reusedExistingCommit).toBe(false);
		expect(preparation.publication).toStrictEqual({
			packageName: '@test/adapter',
			branch: 'npm/adapter',
			commit: await publishFixture.git('rev-parse', ['HEAD']),
			installSpecifier: `git+file://${path.resolve('/remote.git')}#${preparation.publication.commit}`,
			refspec: `${preparation.publication.commit}:refs/heads/npm/adapter`,
		});
	});
});
