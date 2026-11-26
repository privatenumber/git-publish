import path from 'node:path';
import spawn, { type SubprocessError } from 'nano-spawn';

const gitPublishPath = path.resolve('./dist/index.js');

export const gitPublish = (
	cwd: string,
	args: string[] = [],
	environment: NodeJS.ProcessEnv = {},
) => spawn(gitPublishPath, args, {
	cwd,
	env: {
		PATH: process.env.PATH,
		// Tests match plain text, and CI=true would otherwise turn colors on
		NO_COLOR: '1',
		...environment,
	},
}).catch(error => error as SubprocessError);
