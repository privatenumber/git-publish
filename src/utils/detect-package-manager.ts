import fs from 'node:fs/promises';

export const detectPackageManager = () => Promise.any([
	fs.access('package-lock.json').then(() => 'npm'),
	fs.access('yarn.lock').then(() => 'yarn'),
	fs.access('pnpm-lock.yaml').then(() => 'pnpm'),
	fs.access('bun.lockb').then(() => 'bun'),
]);
