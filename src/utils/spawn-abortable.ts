import spawn, { type Options } from 'nano-spawn';

export const spawnAbortable = (file: string, args: string[], options: Options) => {
	options.signal?.throwIfAborted();
	const posix = process.platform !== 'win32';
	const subprocess = spawn(file, args, posix
		? {
			...options,
			signal: undefined,
			detached: true,
		}
		: options);
	const result = (async () => {
		let onAbort: (() => void) | undefined;
		try {
			if (!posix || !options.signal) {
				return await subprocess;
			}
			const { signal } = options;
			const aborted = (async () => {
				const child = await subprocess.nodeChildProcess;
				return new Promise<never>((_resolve, reject) => {
					onAbort = () => {
						try {
							// Both SIGINT and SIGTERM cancel the child group with SIGTERM.
							process.kill(-child.pid!, 'SIGTERM');
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
								reject(error);
								return;
							}
						}
						reject(signal.reason);
					};
					signal.addEventListener('abort', onAbort, { once: true });
					if (signal.aborted) { onAbort(); }
				});
			})();
			return await Promise.race([subprocess, aborted]);
		} catch (error) {
			const child = await subprocess.nodeChildProcess.catch(() => undefined);
			if (child && child.exitCode === null && child.signalCode === null) {
				await new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
			}
			if (options.signal?.aborted) {
				// Descendants can keep inherited pipes open after the direct child exits.
				child?.stdin?.destroy();
				child?.stdout?.destroy();
				child?.stderr?.destroy();
			}
			options.signal?.throwIfAborted();
			throw error;
		} finally {
			if (onAbort) { options.signal?.removeEventListener('abort', onAbort); }
		}
	})();
	return Object.assign(result, { nodeChildProcess: subprocess.nodeChildProcess });
};
