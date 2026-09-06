const globSpecial = /[*?[\]{}]/;

const normalizeFilesFieldEntry = (entry: string) => (
	entry.replaceAll(/^\//g, '').replaceAll(/\/+$/g, '')
);

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const matchesFilesFieldEntry = (
	packedFile: string,
	entry: string,
) => {
	if (!globSpecial.test(entry)) {
		return packedFile === entry || packedFile.startsWith(`${entry}/`);
	}

	const source = escapeRegExp(entry)
		.replaceAll(String.raw`\*\*`, '.*')
		.replaceAll(String.raw`\*`, '[^/]*')
		.replaceAll(String.raw`\?`, '[^/]');
	return new RegExp(`^${source}(?:/.*)?$`).test(packedFile);
};

export const findUnpublishedFilesFieldEntries = (
	filesField: unknown,
	packedFiles: readonly string[],
) => {
	if (!Array.isArray(filesField)) {
		return [];
	}

	const unpublished: string[] = [];
	for (const entry of filesField) {
		if (typeof entry !== 'string' || entry.length === 0 || entry.startsWith('!')) {
			continue;
		}

		const normalized = normalizeFilesFieldEntry(entry);
		if (!normalized) {
			continue;
		}

		if (!packedFiles.some(packedFile => matchesFilesFieldEntry(packedFile, normalized))) {
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
