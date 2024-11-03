import path from 'node:path';
import fs from 'node:fs/promises';
import { execa, type Options } from 'execa';

export const createGit = async (
	cwd: string,
) => {
	const git = (
		command: string,
		args?: string[],
		options?: Options,
	) => (
		execa(
			'git',
			[command, ...(args || [])],
			{
				cwd,
				...options,
			},
		)
	);

	const gitExists = await fs.access(path.join(cwd, '.git')).then(() => true, () => false);

	if (!gitExists) {
		await git(
			'init',
			[
				// In case of different default branch name
				'--initial-branch=master',
			],
		);
	}

	await git('config', ['user.name', 'name']);
	await git('config', ['user.email', 'email']);

	return git;
};
