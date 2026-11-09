import spawn from 'nano-spawn';
import { expect, test } from 'manten';
import { getErrorDetails } from '../../src/utils/error.ts';
import { redactRemote } from '../../src/utils/git-url.ts';

test('redacts username tokens while preserving SSH usernames', () => {
	expect(redactRemote("https://host/repo.git?access_token=abc'def trailing"))
		.toBe('https://host/repo.git?[redacted] trailing');
	expect(redactRemote('ssh://git@host/repo.git?access_token=secret'))
		.toBe('ssh://git@host/repo.git?[redacted]');
	expect(redactRemote('https://host/repo.git?access_token=secret'))
		.toBe('https://host/repo.git?[redacted]');
	for (const scheme of ['http', 'https', 'git', 'git+https']) {
		expect(redactRemote(`${scheme}://ghp_secret@github.com/o/r.git`))
			.toBe(`${scheme}://[redacted]@github.com/o/r.git`);
	}
	expect(redactRemote('ssh://git@host/r.git')).toBe('ssh://git@host/r.git');
	expect(redactRemote('ssh://git:secret@host/r.git')).toBe('ssh://[redacted]@host/r.git');
});

for (const [input, expected] of [
	['s3://token@bucket/repo.git?token=secret', 's3://[redacted]@bucket/repo.git?[redacted]'],
	['ftp://token@host/r', 'ftp://[redacted]@host/r'],
	['helper://user:pass@host/r?token=secret', 'helper://[redacted]@host/r?[redacted]'],
]) {
	test(`redacts custom remote ${expected}`, () => {
		expect(redactRemote(input)).toBe(expected);
	});
}

test('preserves remotes without credentials and Windows paths', () => {
	for (const input of [
		'ssh://git@github.com/o/r.git',
		'git@github.com:o/r.git',
		'https://github.com/o/r.git',
		'C://work/repo.git',
		'C://user:pass@work/repo.git?token=secret',
		'git+C://user:pass@work/repo.git?token=secret',
	]) {
		expect(redactRemote(input)).toBe(input);
	}
});

test('formats nested cleanup and subprocess diagnostics', async () => {
	let subprocessError: unknown;
	try {
		await spawn(process.execPath, ['-'], {
			stdin: { string: 'console.error("worktree removal failed"); process.exit(1)' },
		});
	} catch (error) {
		subprocessError = error;
	}
	const cleanupError = new AggregateError([
		new AggregateError([subprocessError], 'Nested cleanup failure'),
		new Error('Temporary directory removal failed'),
	], 'Cleanup failed');

	expect(getErrorDetails(cleanupError)).toContain('worktree removal failed');
	expect(getErrorDetails(cleanupError)).toContain('Temporary directory removal failed');
});
