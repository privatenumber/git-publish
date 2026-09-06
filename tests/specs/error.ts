import spawn from 'nano-spawn';
import { expect, test } from 'manten';
import { getErrorDetails } from '../../src/utils/error.ts';

test('formats nested cleanup and subprocess diagnostics', async () => {
	let subprocessError: unknown;
	try {
		await spawn(process.execPath, ['-e', 'console.error("worktree removal failed"); process.exit(1)']);
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
