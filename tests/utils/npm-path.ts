import fs from 'node:fs';
import path from 'node:path';

const findOnPath = (command: string) => {
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!directory) {
			continue;
		}

		// Absolute, because the shims run from other directories
		const candidate = path.resolve(directory, command);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			if (fs.statSync(candidate).isFile()) {
				return candidate;
			}
		} catch {
			// Not in this directory or not executable; keep searching
		}
	}
	throw new Error(`${command} not found on PATH`);
};

/**
 * The real npm, resolved before tests prepend their own `npm` shims to PATH.
 * It is not always next to `process.execPath`: some Node runtimes, such as
 * pnpm-managed ones, ship without npm.
 */
export const npmPath = findOnPath('npm');
