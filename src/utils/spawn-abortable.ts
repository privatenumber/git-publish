import spawn, { type Options } from 'nano-spawn';

export const spawnAbortable = async (file: string, args: string[], options: Options) => {
	options.signal?.throwIfAborted();
	const subprocess = spawn(file, args, options);
	try {
		return await subprocess;
	} catch (error) {
		const child = await subprocess.nodeChildProcess.catch(() => undefined);
		if (child && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => { child.once('close', () => resolve()); });
		}
		throw error;
	}
};
