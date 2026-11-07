import type { Writable } from 'node:stream';
import { SubprocessError } from 'nano-spawn';
import { redactRemote } from './redact-remote.ts';

export const getErrorDetails = (error: unknown): string => {
	if (error instanceof AggregateError) {
		return error.errors.map(getErrorDetails).join('\n');
	}
	if (error instanceof SubprocessError) {
		return redactRemote(error.output || error.stderr || error.message);
	}

	return redactRemote(error instanceof Error ? error.message : String(error));
};

export const writeSubprocessErrorOutput = (stream: Writable, error: unknown) => {
	if (!(error instanceof SubprocessError)) {
		return;
	}
	const details = error.output || error.stderr;
	if (details) {
		stream.write(redactRemote(details));
	}
};
