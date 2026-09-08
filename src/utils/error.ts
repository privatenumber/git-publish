import type { Writable } from 'node:stream';
import { SubprocessError } from 'nano-spawn';

export const getErrorDetails = (error: unknown): string => {
	if (error instanceof AggregateError) {
		return error.errors.map(getErrorDetails).join('\n');
	}
	if (error instanceof SubprocessError) {
		return error.output || error.stderr || error.message;
	}

	return error instanceof Error ? error.message : String(error);
};

export const writeSubprocessErrorOutput = (stream: Writable, error: unknown) => {
	if (!(error instanceof SubprocessError)) {
		return;
	}
	const details = error.output || error.stderr;
	if (details) {
		stream.write(details);
	}
};
