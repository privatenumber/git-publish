import path from 'node:path';
import spawn from 'nano-spawn';

/**
 * npm is not always next to `process.execPath` (pnpm-managed Node runtimes
 * ship without it), so resolve it from PATH. Absolute, because the shims run
 * from other directories.
 */
const { stdout } = await spawn('which', ['npm']);
export const npmPath = path.resolve(stdout);
