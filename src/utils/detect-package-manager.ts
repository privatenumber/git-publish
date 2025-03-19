import fs from 'node:fs/promises';
import path from "node:path";
import {access} from "node:fs";

export const detectPackageManager = (cwd: string) => Promise.any([
	fs.access(path.join(cwd, 'package-lock.json')).then(() => 'npm'),
	fs.access(path.join(cwd, 'yarn.lock')).then(() => 'yarn'),
	fs.access(path.join(cwd, 'pnpm-lock.yaml')).then(() => 'pnpm'),
	fs.access(path.join(cwd, 'bun.lockb')).then(() => 'bun'),
]);
