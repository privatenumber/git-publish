import path from 'node:path';
import spawn, { type SubprocessError } from 'nano-spawn';

const gitPublishPath = path.resolve('./dist/index.js');

export const gitPublish = (
	cwd: string,
	args: string[] = [],
) => spawn(gitPublishPath, args, {
	cwd,
	// Remove CI env var which prevents Ink from rendering
	env: {
		PATH: process.env.PATH,
	},
}).catch(error => error as SubprocessError);
