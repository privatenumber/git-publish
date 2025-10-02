import { findUp } from 'find-up-simple';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export const detectPackageManager = async (
	cwd: string,
	stopAt: string,
): Promise<PackageManager> => {
	const config = {
		cwd,
		stopAt,
	};
	if (await findUp('pnpm-lock.yaml', config)) {
		return 'pnpm';
	}

	if (await findUp('yarn.lock', config)) {
		return 'yarn';
	}

	if (await findUp('bun.lockb', config) || await findUp('bun.lock', config)) {
		return 'bun';
	}

	return 'npm';
};
