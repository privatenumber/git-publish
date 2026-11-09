import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { describe, expect, test } from 'manten';
import { createFixture } from 'fs-fixture';
import tarFs from 'tar-fs';
import tar from 'tar-stream';
import { importTarball } from '../../src/package-publication/import-tarball.ts';
import {
	preparePackagePublication, toInstallSpecifier,
} from '../../src/package-publication/prepare.ts';
import { validatePackedWorkspaceDependencies } from '../../src/package-publication/validate.ts';
import { createGitFixture } from '../utils/create-git.ts';

describe('Package publication', () => {
	test('rejects an escaping chain of packed symlinks', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('chain.tgz');
		const pack = tar.pack();
		pack.entry({
			name: 'package/a',
			type: 'symlink',
			linkname: 'sub/link/../outside',
		});
		pack.entry({
			name: 'package/sub/link',
			type: 'symlink',
			linkname: '..',
		});
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		await expect(importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		})).rejects.toThrow('Invalid packed path');
	});

	test('rejects cyclic packed symlinks', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('cycle.tgz');
		const pack = tar.pack();
		pack.entry({
			name: 'package/a',
			type: 'symlink',
			linkname: 'b',
		});
		pack.entry({
			name: 'package/b',
			type: 'symlink',
			linkname: 'a',
		});
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		await expect(importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		})).rejects.toThrow('Invalid packed path');
	});

	test('preserves the hard link entry executable mode', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('hardlink-mode.tgz');
		const pack = tar.pack();
		pack.entry({
			name: 'package/source',
			mode: 0o644,
		}, 'content');
		pack.entry({
			name: 'package/bin',
			type: 'link',
			linkname: 'package/source',
			mode: 0o755,
		});
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		const files = await importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		});
		expect(await repository.git('show', ['refs/git-publish/0:bin'])).toBe('content');
		expect(await repository.git('ls-tree', ['refs/git-publish/0', 'bin'])).toMatch(/^100755 blob /);
		expect(files.find(file => file.file === 'bin')?.size).toBe(7);
	});

	for (const target of ['../sibling/index.js', '/outside/index.js', '.git/config']) {
		test(`rejects unsafe packed symlink target ${target}`, async () => {
			await using fixture = await createFixture();
			await using repository = await createGitFixture();
			const tarball = fixture.getPath('unsafe-link.tgz');
			const pack = tar.pack();
			pack.entry({
				name: 'package/index.js',
				type: 'symlink',
				linkname: target,
			});
			pack.finalize();
			await pipeline(pack, createGzip(), createWriteStream(tarball));
			await expect(importTarball({
				tarball,
				ref: 'refs/git-publish/0',
				parent: undefined,
				message: 'test',
				gitOptions: { cwd: repository.path },
				rewriteManifest: content => content,
			})).rejects.toThrow(`Invalid packed path: "index.js" -> ${JSON.stringify(target)}`);
		});
	}

	test('imports an in-package relative symlink target', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('relative-link.tgz');
		const pack = tar.pack();
		pack.entry({
			name: 'package/current',
			type: 'symlink',
			linkname: 'bin/cli',
		});
		pack.entry({
			name: 'package/bin/cli',
			type: 'symlink',
			linkname: '../dist/cli.js',
		});
		pack.entry({ name: 'package/dist/cli.js' }, 'content');
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		await importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		});
		expect(await repository.git('show', ['refs/git-publish/0:bin/cli'])).toBe('../dist/cli.js');
		expect(await repository.git('show', ['refs/git-publish/0:current'])).toBe('bin/cli');
	});
	test('preserves original packed manifest bytes in a hard link', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('manifest-hardlink.tgz');
		const original = '{"name":"original"}';
		const pack = tar.pack();
		pack.entry({
			name: 'package/package.json',
			mode: 0o755,
		}, original);
		pack.entry({
			name: 'package/copy.json',
			type: 'link',
			linkname: 'package/package.json',
			mode: 0o755,
		});
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		const files = await importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: () => Buffer.from('{"name":"rewritten"}'),
		});
		expect(await repository.git('show', ['refs/git-publish/0:package.json'])).toBe('{"name":"rewritten"}');
		expect(await repository.git('show', ['refs/git-publish/0:copy.json'])).toBe(original);
		expect(await repository.git('ls-tree', ['refs/git-publish/0', 'copy.json'])).toMatch(/^100755 blob /);
		expect(files.find(file => file.file === 'copy.json')?.size).toBe(Buffer.byteLength(original));
	});
	test('rejects a packed package.json symbolic link', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('manifest-link.tgz');
		const pack = tar.pack();
		pack.entry({
			name: 'package/package.json',
			type: 'symlink',
			linkname: 'manifest.json',
		});
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		await expect(importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		})).rejects.toThrow('Packed package.json must be a regular file');
	});

	test('imports a packed POSIX filename containing a backslash', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('backslash.tgz');
		const pack = tar.pack();
		pack.entry({ name: String.raw`package/C:\file.js` }, 'content');
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		await importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		});
		expect(await repository.git('show', [String.raw`refs/git-publish/0:C:\file.js`])).toBe('content');
	});

	test('imports packed hard links with the source mode and size', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('hardlink.tgz');
		const pack = tar.pack();
		pack.entry({
			name: 'package/a"source',
			mode: 0o755,
		}, 'content');
		pack.entry({
			name: 'package/b"copy',
			type: 'link',
			linkname: 'package/a"source',
			mode: 0o755,
		});
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		const files = await importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		});
		expect(await repository.git('show', ['refs/git-publish/0:b"copy'])).toBe('content');
		expect(await repository.git('ls-tree', ['refs/git-publish/0', 'b"copy'])).toMatch(/^100755 blob /);
		expect(files).toStrictEqual([{
			file: 'a"source',
			size: 7,
		}, {
			file: 'b"copy',
			size: 7,
		}]);
	});

	test('imports packed symbolic links as Git symbolic links', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('link.tgz');
		const pack = tar.pack();
		pack.entry({
			name: 'package/link',
			type: 'symlink',
			linkname: 'target',
		});
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		const files = await importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		});
		expect(await repository.git('ls-tree', ['refs/git-publish/0', 'link'])).toMatch(/^120000 blob /);
		expect(await repository.git('show', ['refs/git-publish/0:link'])).toBe('target');
		expect(files).toStrictEqual([{
			file: 'link',
			size: 6,
		}]);
	});

	test('rejects packed paths outside the publication tree', async () => {
		await using fixture = await createFixture();
		await using repository = await createGitFixture();
		const tarball = fixture.getPath('invalid.tgz');
		const pack = tar.pack();
		pack.entry({ name: 'package/../escape' }, 'content');
		pack.finalize();
		await pipeline(pack, createGzip(), createWriteStream(tarball));
		await expect(importTarball({
			tarball,
			ref: 'refs/git-publish/0',
			parent: undefined,
			message: 'test',
			gitOptions: { cwd: repository.path },
			rewriteManifest: content => content,
		})).rejects.toThrow('Invalid packed path');
	});
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
			importRef: 'refs/git-publish/0',
			parent: undefined,
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
			gitOptions: { cwd: publishFixture.path },
		});
		const manifest = JSON.parse(await publishFixture.git('show', [`${preparation.publication.commit}:package.json`]));
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
		expect(preparation.files.find(file => file.file === 'package.json')?.size)
			.toBe(Buffer.byteLength(await publishFixture.git('show', [`${preparation.publication.commit}:package.json`])));
		expect(preparation.reusedExistingCommit).toBe(false);
		expect(await publishFixture.git('cat-file', ['-t', preparation.publication.commit])).toBe('commit');
		expect(await publishFixture.git('rev-parse', ['refs/git-publish/0'])).toBe(preparation.publication.commit);
		expect(await publishFixture.git('rev-parse', [`${preparation.publication.commit}^{tree}`]))
			.toBe(await publishFixture.git('rev-parse', ['refs/git-publish/0^{tree}']));
		expect(preparation.publication).toStrictEqual({
			packageName: '@test/adapter',
			branch: 'npm/adapter',
			commit: preparation.publication.commit,
			installSpecifier: `git+file://${path.resolve('/remote.git')}#${preparation.publication.commit}`,
		});
	});
});
