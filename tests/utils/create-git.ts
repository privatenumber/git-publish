import spawn from 'nano-spawn';

export const createGit = async (
	cwd: string,
) => {
	const git = (
		command: string,
		args?: string[],
	) => (
		spawn(
			'git',
			[command, ...(args || [])],
			{
				cwd,
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
