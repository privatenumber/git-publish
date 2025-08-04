import spawn, { type Options as SpawnOptions } from 'nano-spawn';

export const simpleSpawn = async (
	command: string,
	args: string[],
	options?: SpawnOptions,
) => {
	const result = await spawn(command, args, options);
	return result.stdout.trim();
};
