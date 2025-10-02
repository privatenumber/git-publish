import { findUp } from 'find-up-simple';

export const detectPackageManager = async (
	cwd: string,
	stopAt: string,
) => {
	const config = { cwd, stopAt };
	if (await findUp('pnpm-lock.yaml', config)) {
		return 'pnpm' as const;
	}

	if (await findUp('yarn.lock', config)) {
		return 'yarn' as const;
	}

	if (await findUp('bun.lockb', config) || await findUp('bun.lock', config)) {
		return 'bun' as const;
	}

	return 'npm' as const;
};
