import fs from 'node:fs/promises';

export const readJson = async (path: string) => {
	const jsonString = await fs.readFile(path, 'utf8');
	try {
		return JSON.parse(jsonString) as unknown;
	} catch {
		throw new Error(`Failed to parse JSON file: ${path}`);
	}
};
