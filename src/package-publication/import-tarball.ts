import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buffer } from 'node:stream/consumers';
import path from 'node:path';
import spawn, { type Options } from 'nano-spawn';
import gunzip from 'gunzip-maybe';
import tar from 'tar-stream';

const packedPath = (name: string) => {
	const file = name.startsWith('package/') ? name.slice(8) : name;
	if (path.posix.isAbsolute(file) || file.includes('\0') || file.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
		throw new Error(`Invalid packed path: ${JSON.stringify(file)}`);
	}
	return file;
};

// git-fast-import <path> accepts C-style quoted paths, including octal escapes.
const quotePath = (name: string) => `"${[...Buffer.from(name)].map(byte => (byte >= 0x20 && byte < 0x7F && byte !== 34 && byte !== 92 ? String.fromCodePoint(byte) : `\\${byte.toString(8).padStart(3, '0')}`)).join('')}"`;

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
	for (const [name, entry] of entries) {
		if (entry.target === undefined) {
			continue;
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
			const target = entries.get(resolved.join('/'))?.target;
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
	tarball, ref, parent, message, gitOptions, rewriteManifest,
}: {
	tarball: string;
	ref: string;
	parent: string | undefined;
	message: string;
	gitOptions: Options;
	rewriteManifest: (content: Buffer) => Buffer;
}) => {
	const entries = new Map<string, PackedEntry>();
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
					// eslint-disable-next-line no-bitwise -- Check the three executable permission bits.
					const mode = ((header.mode ?? 0) & 0o111) ? '100755' : '100644';
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
				if (header.type === 'symlink') {
					const target = header.linkname ?? '';
					const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
					if (path.posix.isAbsolute(target) || target.includes('\0') || resolved === '..' || resolved.startsWith('../') || resolved.split('/').some(part => part.toLowerCase() === '.git')) {
						throw new Error(`Invalid packed path: ${JSON.stringify(name)} -> ${JSON.stringify(target)}`);
					}
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
				// eslint-disable-next-line no-bitwise -- Check the three executable permission bits.
				const mode = header.type === 'symlink' ? '120000' : (((header.mode ?? 0) & 0o111) ? '100755' : '100644');
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
		const messageData = Buffer.from(`${message}\n`);
		const now = Math.floor(Date.now() / 1000);
		yield `commit ${ref}\nauthor git-publish <bot@git-publish> ${now} +0000\ncommitter git-publish <bot@git-publish> ${now} +0000\ndata ${messageData.length}\n`;
		yield messageData;
		yield `\n${parent ? `from ${parent}\n` : ''}deleteall\n`;
		for (const [name, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0)))) {
			yield `M ${entry.mode} :${entry.mark} ${quotePath(name)}\n`;
		}
		yield '\n';
	};
	const writeResult = pipeline(Readable.from(generate()), input);
	const [written, imported] = await Promise.allSettled([writeResult, processResult]);
	// Prefer Git's diagnostic over the EPIPE caused by its early exit.
	if (imported.status === 'rejected' && (written.status === 'fulfilled' || (written.reason as NodeJS.ErrnoException).code === 'EPIPE')) {
		throw imported.reason;
	}
	if (written.status === 'rejected') {
		throw written.reason;
	}
	if (imported.status === 'rejected') {
		throw imported.reason;
	}
	return [...entries].map(([file, entry]) => ({
		file,
		size: entry.size,
	})).sort((a, b) => (a.file < b.file ? -1 : (a.file > b.file ? 1 : 0)));
};
