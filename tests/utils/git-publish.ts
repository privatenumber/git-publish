import path from 'node:path';
import { execa } from 'execa';

const gitPublishPath = path.resolve('./dist/index.js');

export const gitPublish = (
	cwd: string,
) => execa(gitPublishPath, {
	cwd,
	reject: false,
	// Remove CI env var which prevents Ink from rendering
	env: {
		PATH: process.env.PATH,
	},
	extendEnv: false,
});
