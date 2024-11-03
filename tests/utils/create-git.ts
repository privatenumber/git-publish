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

	await git(
		'init',
		[
			// In case of different default branch name
			'--initial-branch=master',
		],
	);

	await git('config', ['user.name', 'name']);
	await git('config', ['user.email', 'email']);

	return git;
};
