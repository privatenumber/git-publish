import fs from 'fs';
import { execa } from 'execa';

export async function assertCleanTree() {
	const { stdout } = await execa('git', ['status', '--porcelain', '--untracked-files=no']).catch((error) => {
		if (error.stderr.includes('not a git repository')) {
			throw new Error('Not in a git repository');
		}

		throw error;
	});

	if (stdout) {
		throw new Error('Working tree is not clean');
	}
}

export async function getCurrentBranchOrTagName() {
	/**
	 * This commands supports older versions of Git, but since v2.22, you can do:
	 * git branch --show-current
	 */
	const getBranch = await execa(
		'git',
		['symbolic-ref', '--short', '-q', 'HEAD'],
		{ reject: false },
	);

	if (getBranch.stdout) {
		return getBranch.stdout;
	}

	const getTag = await execa(
		'git',
		['describe', '--tags'],
		{ reject: false },
	);

	if (getTag.stdout) {
		return getTag.stdout;
	}

	throw new Error(`Failed to get current branch name: ${getBranch.stderr} ${getTag.stderr}`);
}

export async function readJson(path: string) {
	const jsonString = await fs.promises.readFile(path, 'utf8');
	try {
		return JSON.parse(jsonString);
	} catch {
		throw new Error(`Failed to parse JSON file: ${path}`);
	}
}
