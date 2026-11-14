import spawn, { type Options } from 'nano-spawn';

export const spawnAbortable = (file: string, args: string[], options: Options) => {
	options.signal?.throwIfAborted();
	const subprocess = spawn(file, args, options);
	const result = (async () => {
		try {
			return await subprocess;
		} catch (error) {
			const child = await subprocess.nodeChildProcess.catch(() => undefined);
			if (child && child.exitCode === null && child.signalCode === null) {
				await new Promise<void>((resolve) => { child.once('close', () => resolve()); });
			}
			throw error;
		}
	})();
	return Object.assign(result, { nodeChildProcess: subprocess.nodeChildProcess });
};
