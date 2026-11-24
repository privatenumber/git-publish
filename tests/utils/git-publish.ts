import path from 'node:path';
import spawn, { type SubprocessError } from 'nano-spawn';

const gitPublishPath = path.resolve('./dist/index.js');

export const gitPublish = (
	cwd: string,
	args: string[] = [],
	environment: NodeJS.ProcessEnv = {},
) => spawn(gitPublishPath, args, {
	cwd,
	// nano-spawn merges this into process.env, which tests/index.ts isolates
	env: environment,
}).catch(error => error as SubprocessError);
