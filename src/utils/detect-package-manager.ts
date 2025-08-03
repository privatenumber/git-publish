import fs from 'node:fs/promises';

export const detectPackageManager = () => Promise.any([
	fs.access('package-lock.json').then(() => 'npm' as const),
	fs.access('yarn.lock').then(() => 'yarn' as const),
	fs.access('pnpm-lock.yaml').then(() => 'pnpm' as const),
	fs.access('bun.lockb').then(() => 'bun' as const),
]).catch(
	() => 'npm' as const, // If no lock files are found, default to npm
);
