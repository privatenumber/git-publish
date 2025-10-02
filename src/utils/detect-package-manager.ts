import { findUp } from 'find-up-simple';

export const detectPackageManager = async (
	cwd: string,
	stopAt: string,
) => {
	if (await findUp('pnpm-lock.yaml', {
		cwd,
		stopAt,
	})) {
		return 'pnpm' as const;
	}

	if (await findUp('yarn.lock', {
		cwd,
		stopAt,
	})) {
		return 'yarn' as const;
	}

	if (await findUp('bun.lockb', {
		cwd,
		stopAt,
	}) || await findUp('bun.lock', {
		cwd,
		stopAt,
	})) {
		return 'bun' as const;
	}

	return 'npm' as const;
};
