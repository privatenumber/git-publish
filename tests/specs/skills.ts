import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'manten';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const skillUrl = new URL('../../skills/git-publish/SKILL.md', import.meta.url);
const { FORCE_COLOR: _forceColor, ...environment } = process.env;

const run = (args: string[], options?: {
	cwd?: string;
	env?: Record<string, string>;
}) => new Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}>((resolve, reject) => {
	execFile(process.execPath, [cliPath, ...args], {
		cwd: options?.cwd,
		env: {
			...environment,
			NO_COLOR: '1',
			...options?.env,
		},
	}, (error, stdout, stderr) => {
		if (error && typeof error.code !== 'number') {
			reject(error);
			return;
		}
		resolve({
			exitCode: typeof error?.code === 'number' ? error.code : 0,
			stdout,
			stderr,
		});
	});
});

const withTemporaryDirectory = async (callback: (directory: string) => Promise<void>) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-skills-'));
	try {
		await callback(directory);
	} finally {
		await fs.rm(directory, {
			recursive: true,
			force: true,
		});
	}
};

describe('skills', () => {
	test('prints the bundled skill', async () => {
		expect(await run(['skills'])).toStrictEqual({
			exitCode: 0,
			stdout: await fs.readFile(skillUrl, 'utf8'),
			stderr: '',
		});
	});

	test('--install creates missing directories', async () => {
		await withTemporaryDirectory(async (directory) => {
			const destination = path.join(await fs.realpath(directory), '.agents', 'skills', 'git-publish');
			expect(await run(['skills', '--install', '.agents/skills/'], { cwd: directory })).toStrictEqual({
				exitCode: 0,
				stdout: '',
				stderr: `Installed the git-publish skill to ${destination}\n`,
			});
			expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(await fs.readFile(skillUrl, 'utf8'));
		});
	});

	test('--install overwrites an earlier copy', async () => {
		await withTemporaryDirectory(async (directory) => {
			const destination = path.join(directory, 'git-publish');
			await fs.mkdir(destination);
			await fs.writeFile(path.join(destination, 'SKILL.md'), 'outdated');
			expect(await run(['skills', '--install', directory])).toStrictEqual({
				exitCode: 0,
				stdout: '',
				stderr: `Installed the git-publish skill to ${destination}\n`,
			});
			expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(await fs.readFile(skillUrl, 'utf8'));
		});
	});

	test('--install= expands a leading ~ to the home directory', async () => {
		await withTemporaryDirectory(async (directory) => {
			const destination = path.join(directory, '.claude', 'skills', 'git-publish');
			expect(await run(['skills', '--install=~/.claude/skills'], {
				env: {
					HOME: directory,
					USERPROFILE: directory,
				},
			})).toStrictEqual({
				exitCode: 0,
				stdout: '',
				stderr: `Installed the git-publish skill to ${destination}\n`,
			});
			expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(await fs.readFile(skillUrl, 'utf8'));
		});
	});
});
