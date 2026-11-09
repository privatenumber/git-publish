import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buffer } from 'node:stream/consumers';
import path from 'node:path';
import spawn, { type Options } from 'nano-spawn';
import gunzip from 'gunzip-maybe';
import tar from 'tar-stream';

export type File = {
	file: string;
	size: number;
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
	const files: File[] = [];
	const fastImport = spawn('git', ['fast-import', '--quiet'], {
		...gitOptions,
		stdin: 'pipe',
	});
	const { stdin: input } = await fastImport.nodeChildProcess;
	if (!input) {
		throw new Error('Git fast-import stdin is unavailable');
	}
	const processResult = Promise.resolve(fastImport).catch((error: unknown) => {
		input.destroy(error as Error);
		throw error;
	});
	const generate = async function* () {
		const messageData = Buffer.from(`${message}\n`);
		const now = Math.floor(Date.now() / 1000);
		yield `commit ${ref}\nauthor git-publish <bot@git-publish> ${now} +0000\ncommitter git-publish <bot@git-publish> ${now} +0000\ndata ${messageData.length}\n`;
		yield messageData;
		yield `\n${parent ? `from ${parent}\n` : ''}deleteall\n`;
		const extract = tar.extract();
		const extraction = pipeline(createReadStream(tarball), gunzip(), extract);
		// The await below observes failures; handle early rejection while the generator is suspended.
		extraction.catch(() => {});
		try {
			for await (const entry of extract) {
				const { header } = entry;
				const name = header.name.startsWith('package/') ? header.name.slice(8) : header.name;
				if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || name.includes('\0') || name.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) {
					throw new Error(`Invalid packed path: ${JSON.stringify(name)}`);
				}
				if (header.type === 'directory') {
					entry.resume();
					continue;
				}
				if (!name || (header.type !== 'file' && header.type !== 'symlink')) {
					throw new Error(`Unsupported packed entry: ${JSON.stringify(name)} (${header.type})`);
				}
				const content = header.type === 'symlink'
					? Buffer.from(header.linkname ?? '')
					: (name === 'package.json' ? rewriteManifest(await buffer(entry)) : undefined);
				const size = content?.length ?? header.size ?? 0;
				// eslint-disable-next-line no-bitwise -- Check the three executable permission bits.
				const mode = header.type === 'symlink' ? '120000' : (((header.mode ?? 0) & 0o111) ? '100755' : '100644');
				// git-fast-import <path> accepts C-style quoted paths, including octal escapes.
				const quoted = `"${[...Buffer.from(name)].map(byte => (byte >= 0x20 && byte < 0x7F && byte !== 34 && byte !== 92 ? String.fromCodePoint(byte) : `\\${byte.toString(8).padStart(3, '0')}`)).join('')}"`;
				yield `M ${mode} inline ${quoted}\ndata ${size}\n`;
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
				files.push({
					file: name,
					size,
				});
			}
			await extraction;
		} finally {
			extract.destroy();
			// Preserve any entry-processing error while waiting for extraction to stop.
			await extraction.catch(() => {});
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
	return files.sort((a, b) => (a.file < b.file ? -1 : (a.file > b.file ? 1 : 0)));
};
