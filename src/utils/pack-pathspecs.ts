type PackManifest = {
	files?: string[];
	main?: string;
	browser?: string | Record<string, unknown>;
	bin?: string | Record<string, string>;
};

export const packPathspecs = (manifest: PackManifest): string[] => {
	if (!manifest.files) { return []; }
	const pathspecs: string[] = [];
	for (const entry of manifest.files) {
		if (entry.startsWith('!')) { continue; }
		const normalized = entry.replace(/^(?:\.\/)+/, '').replace(/^\//, '').replace(/\/+$/, '');
		if (!normalized) { continue; }
		if (/[{}]|[!+@?*]\(/.test(normalized)) {
			const segments = normalized.split('/');
			const globIndex = segments.findIndex(segment => /[*?[\]{}()]|[!+@]\(/.test(segment));
			const prefix = segments.slice(0, globIndex).join('/');
			pathspecs.push(prefix ? `:(glob)${prefix}/**` : ':(glob)**');
		} else {
			pathspecs.push(`:(glob)${normalized}`, `:(glob)${normalized}/**`);
		}
	}
	const bin = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
	for (const file of [manifest.main, typeof manifest.browser === 'string' ? manifest.browser : undefined, ...bin]) {
		if (file) { pathspecs.push(`:(literal)${file.replace(/^(?:\.\/)+/, '').replace(/^\//, '')}`); }
	}
	for (const name of ['README', 'COPYING', 'LICENSE', 'LICENCE']) {
		pathspecs.push(`:(glob,icase)${name}`, `:(glob,icase)${name}.*`);
	}
	return pathspecs;
};
