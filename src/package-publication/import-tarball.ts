import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buffer } from 'node:stream/consumers';
import path from 'node:path';
import spawn, { type Options } from 'nano-spawn';
import gunzip from 'gunzip-maybe';
import tar from 'tar-stream';
import { getStdout } from '../utils/get-stdout.ts';

const packedPath = (name: string) => {
	const file = name.startsWith('package/') ? name.slice(8) : name;
	if (path.posix.isAbsolute(file) || file.includes('\0') || file.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
		throw new Error(`Invalid packed path: ${JSON.stringify(file)}`);
	}
	return file;
};

// git-fast-import <path> accepts C-style quoted paths, including octal escapes.
const quotePath = (name: string) => `"${[...Buffer.from(name)].map(byte => (byte >= 0x20 && byte < 0x7F && byte !== 34 && byte !== 92 ? String.fromCodePoint(byte) : `\\${byte.toString(8).padStart(3, '0')}`)).join('')}"`;

// eslint-disable-next-line no-bitwise -- Check the three executable permission bits.
const fileMode = (mode: number | undefined) => (((mode ?? 0) & 0o111) ? '100755' : '100644');

export type File = {
	file: string;
	size: number;
};

type PackedEntry = {
	mark: number;
	mode: string;
	size: number;
	target?: string;
};

const validateSymlinks = (entries: ReadonlyMap<string, PackedEntry>) => {
	const symlinks = new Map<string, string>();
	for (const [name, entry] of entries) {
		if (entry.target !== undefined) {
			const key = name.toLowerCase();
			if (symlinks.has(key)) {
				throw new Error(`Invalid packed path: ${JSON.stringify(name)} -> ${JSON.stringify(entry.target)}`);
			}
			symlinks.set(key, entry.target);
		}
	}
	for (const [name, entry] of entries) {
		if (entry.target === undefined) {
			continue;
		}
		const lexical = path.posix.normalize(path.posix.join(path.posix.dirname(name), entry.target));
		if (path.posix.isAbsolute(entry.target) || /[\0\\:]/.test(entry.target) || lexical === '..' || lexical.startsWith('../') || lexical.split('/').some(part => part.toLowerCase() === '.git')) {
			throw new Error(`Invalid packed path: ${JSON.stringify(name)} -> ${JSON.stringify(entry.target)}`);
		}
		const resolved = path.posix.dirname(name).split('/').filter(part => part !== '.');
		const pending = entry.target.split('/').reverse();
		let links = 0;
		while (pending.length > 0) {
			const part = pending.pop()!;
			if (!part || part === '.') {
				continue;
			}
			if (part === '..') {
				if (resolved.length === 0) {
					throw new Error(`Invalid packed path: ${JSON.stringify(name)} -> ${JSON.stringify(entry.target)}`);
				}
				resolved.pop();
				continue;
			}
			if (part.toLowerCase() === '.git') {
				throw new Error(`Invalid packed path: ${JSON.stringify(name)} -> ${JSON.stringify(entry.target)}`);
			}
			resolved.push(part);
			const target = symlinks.get(resolved.join('/').toLowerCase());
			if (target !== undefined) {
				links += 1;
				if (links > 40 || path.posix.isAbsolute(target)) {
					throw new Error(`Invalid packed path: ${JSON.stringify(name)} -> ${JSON.stringify(entry.target)}`);
				}
				resolved.pop();
				pending.push(...target.split('/').reverse());
			}
		}
	}
};

export const importTarball = async ({
	tarball, ref, gitOptions, rewriteManifest,
}: {
	tarball: string;
	ref: string;
	gitOptions: Options;
	rewriteManifest: (content: Buffer) => Buffer;
}) => {
	const entries = new Map<string, PackedEntry>();
	let sortedEntries: [string, PackedEntry][] = [];
	const fastImport = spawn('git', ['fast-import', '--quiet'], {
		...gitOptions,
		stdin: 'pipe',
	});
	const result = Promise.resolve(fastImport).then(
		() => ({ error: undefined }),
		(error: unknown) => ({ error }),
	);
	const { stdin: input } = await fastImport.nodeChildProcess;
	if (!input) {
		throw new Error('Git fast-import stdin is unavailable');
	}
	const processResult = result.then(({ error }) => {
		if (error !== undefined) {
			input.destroy(error as Error);
			throw error;
		}
	});
	const generate = async function* () {
		const extract = tar.extract();
		const extraction = pipeline(createReadStream(tarball), gunzip(), extract);
		let nextMark = 0;
		let originalManifest: { mark: number;
			size: number; } | undefined;
		// The await below observes failures; handle early rejection while the generator is suspended.
		extraction.catch(() => {});
		try {
			for await (const entry of extract) {
				const { header } = entry;
				const name = packedPath(header.name);
				if (header.type === 'directory') {
					entry.resume();
					continue;
				}
				if (name === 'package.json' && header.type !== 'file') {
					throw new Error('Packed package.json must be a regular file');
				}
				if (header.type === 'link') {
					const source = packedPath(header.linkname ?? '');
					const linked = source === 'package.json' ? originalManifest : entries.get(source);
					if (!name || !linked) {
						throw new Error(`Invalid packed hard link: ${JSON.stringify(name)} -> ${JSON.stringify(source)}`);
					}
					const mode = fileMode(header.mode);
					entries.set(name, {
						mark: linked.mark,
						mode,
						size: linked.size,
					});
					entry.resume();
					continue;
				}
				if (!name || (header.type !== 'file' && header.type !== 'symlink')) {
					throw new Error(`Unsupported packed entry: ${JSON.stringify(name)} (${header.type})`);
				}
				const manifest = name === 'package.json' ? await buffer(entry) : undefined;
				if (manifest) {
					nextMark += 1;
					originalManifest = {
						mark: nextMark,
						size: manifest.length,
					};
					yield `blob\nmark :${originalManifest.mark}\ndata ${manifest.length}\n`;
					yield manifest;
					yield '\n';
				}
				const content = header.type === 'symlink'
					? Buffer.from(header.linkname ?? '')
					: (manifest ? rewriteManifest(manifest) : undefined);
				const size = content?.length ?? header.size ?? 0;
				const mode = header.type === 'symlink' ? '120000' : fileMode(header.mode);
				nextMark += 1;
				const mark = nextMark;
				yield `blob\nmark :${mark}\ndata ${size}\n`;
				if (content) {
					yield content;
					if (header.type === 'symlink') {
						entry.resume();
					}
				} else {
					for await (const chunk of entry) {
						yield chunk;
					}
				}
				yield '\n';
				entries.set(name, {
					mark,
					mode,
					size,
					target: header.type === 'symlink' ? (header.linkname ?? '') : undefined,
				});
			}
			await extraction;
		} finally {
			extract.destroy();
			// Preserve any entry-processing error while waiting for extraction to stop.
			await extraction.catch(() => {});
		}
		validateSymlinks(entries);
		sortedEntries = [...entries].sort(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0)));
		yield `commit ${ref}\ncommitter git-publish <bot@git-publish> 0 +0000\ndata 0\n\ndeleteall\n`;
		for (const [name, entry] of sortedEntries) {
			yield `M ${entry.mode} :${entry.mark} ${quotePath(name)}\n`;
		}
		yield '\n';
	};
	const writeResult = pipeline(Readable.from(generate()), input);
	const [written, imported] = await Promise.allSettled([writeResult, processResult]);
	// Prefer Git's diagnostic over the EPIPE caused by its early exit.
	if (written.status === 'rejected') {
		throw imported.status === 'rejected' && (written.reason as NodeJS.ErrnoException).code === 'EPIPE' ? imported.reason : written.reason;
	}
	if (imported.status === 'rejected') {
		throw imported.reason;
	}
	const tree = await getStdout(spawn('git', ['rev-parse', `${ref}^{tree}`], gitOptions));
	return {
		tree,
		files: sortedEntries.map(([file, entry]) => ({
			file,
			size: entry.size,
		})),
	};
};
