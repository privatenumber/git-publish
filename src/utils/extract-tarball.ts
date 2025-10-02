import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import tarFs from 'tar-fs';
import gunzip from 'gunzip-maybe';

export type File = {
	file: string;
	size: number;
};

export const extractTarball = async (
	tarballPath: string,
	destinationPath: string,
): Promise<File[]> => {
	const files: File[] = [];

	await pipeline(
		createReadStream(tarballPath),
		gunzip(),
		tarFs.extract(destinationPath, {
			map: (header) => {
				// Strip the 'package/' prefix
				const parts = header.name.split('/');
				if (parts[0] === 'package') {
					parts.shift();
				}
				header.name = parts.join('/');

				// Collect file info (only regular files, not directories)
				if (header.type === 'file' && header.name) {
					files.push({
						file: header.name,
						size: header.size || 0,
					});
				}

				return header;
			},
		}),
	);

	// Sort files alphabetically
	files.sort((a, b) => (a.file < b.file ? -1 : (a.file > b.file ? 1 : 0)));

	return files;
};
