import micromatch from 'micromatch';

const normalizeFilesFieldEntry = (entry: string) => (
	entry.replace(/^(?:\.\/|\/)+/, '').replace(/\/+$/, '')
);

const getPackedPaths = (packedFiles: readonly string[]) => {
	const packedPaths = [...packedFiles];
	const packedPathSet = new Set(packedPaths);
	for (const packedFile of packedFiles) {
		let slashIndex = packedFile.lastIndexOf('/');
		while (slashIndex !== -1) {
			const directory = packedFile.slice(0, slashIndex);
			if (!packedPathSet.has(directory)) {
				packedPathSet.add(directory);
				packedPaths.push(directory);
			}
			slashIndex = packedFile.lastIndexOf('/', slashIndex - 1);
		}
	}

	return packedPaths;
};

export const findUnpublishedFilesFieldEntries = (
	filesField: unknown,
	packedFiles: readonly string[],
) => {
	if (!Array.isArray(filesField)) {
		return [];
	}

	const packedPaths = getPackedPaths(packedFiles);
	const unpublished: string[] = [];
	for (const entry of filesField) {
		if (typeof entry !== 'string' || entry.length === 0 || micromatch.scan(entry).negated) {
			continue;
		}

		const normalized = normalizeFilesFieldEntry(entry);
		if (!normalized) {
			continue;
		}

		const matchesEntry = micromatch.matcher(normalized);
		let hasMatch = false;
		for (const packedPath of packedPaths) {
			if (matchesEntry(packedPath)) {
				hasMatch = true;
				break;
			}
		}
		if (!hasMatch) {
			unpublished.push(entry);
		}
	}

	return unpublished;
};

export const formatUnpublishedFilesFieldWarning = (
	entries: readonly string[],
) => {
	if (entries.length === 0) {
		return undefined;
	}

	const listed = entries.map(entry => JSON.stringify(entry)).join(', ');
	return `package.json "files" lists paths that were not published: ${listed}`;
};
