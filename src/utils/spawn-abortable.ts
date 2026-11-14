import spawn, { type Options } from 'nano-spawn';

export const spawnAbortable = (
	file: string,
	args: string[],
	options: Options,
	{ processGroup = false }: { processGroup?: boolean } = {},
) => {
	options.signal?.throwIfAborted();
	const group = processGroup && process.platform !== 'win32';
	const subprocess = spawn(file, args, group
		? {
			...options,
			signal: undefined,
			detached: true,
		}
		: options);
	const result = (async () => {
		let onAbort: (() => void) | undefined;
		let onExit: (() => void) | undefined;
		try {
			if (!group) {
				return await subprocess;
			}
			const { signal } = options;
			const aborted = (async () => {
				const child = await subprocess.nodeChildProcess;
				onExit = () => {
					try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
					}
				};
				process.on('exit', onExit);
				if (!signal) { return await subprocess; }
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
			if (onExit) { process.removeListener('exit', onExit); }
		}
	})();
	return Object.assign(result, { nodeChildProcess: subprocess.nodeChildProcess });
};
