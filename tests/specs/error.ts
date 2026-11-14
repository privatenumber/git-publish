import spawn from 'nano-spawn';
import { expect, test } from 'manten';
import { getErrorDetails } from '../../src/utils/error.ts';
import { redactRemote } from '../../src/utils/git-url.ts';

for (const [index, [input, expected]] of [
	['ext::env TOKEN=secret git-upload-pack .', 'ext::[redacted]'],
	['https://user:secret/part@host/repo', 'https://[redacted]'],
	['https://user:pass@example.test?token=prefix@secret', 'https://[redacted]'],
	['https://user:secret#tail@host/repo.git', 'https://[redacted]'],
	['git@host:repo.git?token=secret', 'git@host:repo.git?[redacted]'],
	['ssh://git@host/repo/https://u:secret@other/r', 'ssh://[redacted]'],
	['ssh://git@host/repo/https://other/r', 'ssh://[redacted]'],
].entries()) {
	test(`redacts custom remote ${index}: ${expected}`, () => {
		expect(redactRemote(input)).toBe(expected);
	});
}

test('preserves remotes without credentials and Windows paths', () => {
	for (const input of [
		'ssh://git@github.com/o/r.git',
		'git@github.com:o/r.git',
		'https://github.com/o/r.git',
		'C://work/repo.git',
		'https://[2001:db8::1]/repo.git',
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
