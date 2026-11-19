import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import net from 'node:net';
import spawn from 'nano-spawn';
import {
	describe, test, expect, onTestFail,
} from 'manten';
import { createFixture } from 'fs-fixture';
import { spawnAbortable } from '../../src/utils/spawn-abortable.ts';
import { createGitFixture } from '../utils/create-git.ts';

const monitorSignalChild = (child: ChildProcess) => {
	const started = performance.now();
	const deadline = started + 30_000;
	let output = '';
	const capture = (chunk: string) => {
		output += chunk;
	};
	for (const stream of [child.stdout, child.stderr]) {
		stream?.setEncoding('utf8').on('data', capture);
	}
	onTestFail(() => console.log(output || '(no CLI output)'));

	// Unlike events.once(), this also waits for the streams to close after a spawn error.
	const { promise: closed, resolve } = Promise.withResolvers<number | null>();
	child.once('close', resolve);

	// The failure races are created per wait, so no rejection exists without a consumer
	const waitFor = async <Value>(
		step: string,
		event: Promise<Value>,
		{ allowExit = false } = {},
	) => {
		const waitingSince = performance.now();
		const stopListening = new AbortController();
		const { signal } = stopListening;
		const expired = async () => {
			await setTimeout(deadline - performance.now(), undefined, {
				signal,
				ref: false,
			});
			throw new Error('CLI watchdog expired');
		};
		const exited = async () => {
			if (child.exitCode === null && child.signalCode === null) {
				await once(child, 'exit', { signal });
			}
			throw new Error('CLI exited early');
		};
		try {
			return await Promise.race(allowExit ? [event, expired()] : [event, expired(), exited()]);
		} catch (error) {
			const now = performance.now();
			throw new Error(`Waiting for ${step} failed after ${Math.round(now - waitingSince)}ms (${Math.round(now - started)}ms since CLI spawn; exit code: ${child.exitCode}, signal: ${child.signalCode})`, { cause: error });
		} finally {
			// Remove the losing listener and timer; Promise.race already handles their AbortErrors
			stopListening.abort();
		}
	};
	return {
		waitFor,
		closed,
		get output() { return output; },
	};
};

await describe('Signals', () => {
	test('stops a subprocess when aborted immediately after spawn', async () => {
		const controller = new AbortController();
		const reason = new Error('interrupted');
		const subprocess = spawnAbortable(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			signal: controller.signal,
		}, { processGroup: true });
		controller.abort(reason);
		const child = await subprocess.nodeChildProcess;
		expect(await subprocess.catch(error => error)).toBe(reason);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});
	test('cleans up after SIGTERM during worktree creation', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using temporary = await createFixture();
		await using marker = await createFixture();
		await fs.writeFile(marker.getPath('filter.cjs'), `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker.getPath('ready'))}, ''); setInterval(() => {}, 1 << 30);`);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
			}),
			'.gitattributes': 'filtered.txt filter=block\n',
			'filtered.txt': 'content',
		}, ['--initial-branch=signal-worktree']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);
		await fixture.git('config', ['filter.block.smudge', `exec "${process.execPath}" "${marker.getPath('filter.cjs')}"`]);
		const watchController = new AbortController();
		const watcher = fs.watch(marker.path, { signal: watchController.signal });
		const ready = (async () => {
			if (await marker.exists('ready')) { return; }
			for await (const _event of watcher) {
				if (await marker.exists('ready')) { return; }
			}
		})();
		const child = spawnChild(process.execPath, [path.resolve('dist/index.js')], {
			cwd: fixture.path,
			env: {
				...process.env,
				TMPDIR: temporary.path,
				NODE_DISABLE_COMPILE_CACHE: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		});
		const cli = monitorSignalChild(child);
		try {
			await cli.waitFor('worktree ready marker', ready);
			child.kill('SIGTERM');
			const code = await cli.waitFor('CLI close after SIGTERM', cli.closed, { allowExit: true });
			expect(code).toBe(143);
			expect(cli.output.match(/Publication interrupted\./g)?.length).toBe(1);
			expect(cli.output).not.toContain('Command failed');
			expect(await temporary.readdir('')).toStrictEqual([]);
			expect(await remote.git('for-each-ref')).toBe('');
		} finally {
			watchController.abort();
			await watcher.return?.();
			if (child.pid) {
				try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
			}
			await cli.closed;
		}
	});
	for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
		test(`cleans up after ${signal} during npm prepack`, async () => {
			await using remote = await createGitFixture(undefined, ['--bare']);
			await using temporary = await createFixture();
			await using marker = await createFixture();
			await using fixture = await createGitFixture({
				'package.json': JSON.stringify({
					name: 'app',
					version: '1.0.0',
					scripts: { prepack: `"${process.execPath}" hook.cjs` },
				}),
				'hook.cjs': `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker.getPath('pending'))}, String(process.pid)); fs.renameSync(${JSON.stringify(marker.getPath('pending'))}, ${JSON.stringify(marker.getPath('pid'))}); setInterval(() => {}, 1000);`,
			}, ['--initial-branch=signal']);
			await fixture.git('add', ['.']);
			await fixture.git('commit', ['-m', 'Initial commit']);
			await fixture.git('remote', ['add', 'origin', remote.path]);
			const watchController = new AbortController();
			const watcher = fs.watch(marker.path, { signal: watchController.signal });
			const ready = (async () => {
				if (await marker.exists('pid')) { return; }
				for await (const _event of watcher) {
					if (await marker.exists('pid')) { return; }
				}
			})();
			const child = spawnChild(process.execPath, [path.resolve('dist/index.js')], {
				cwd: fixture.path,
				env: {
					...process.env,
					TMPDIR: temporary.path,
					NODE_DISABLE_COMPILE_CACHE: '1',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: true,
			});
			const cli = monitorSignalChild(child);
			try {
				await cli.waitFor('prepack pid marker', ready);
				const hookPid = Number(await marker.readFile('pid', 'utf8'));
				child.kill(signal);
				const code = await cli.waitFor(`CLI close after ${signal}`, cli.closed, { allowExit: true });
				expect(code).toBe(exitCode);
				const ps = await spawn('ps', ['-o', 'stat=', '-p', String(hookPid)])
					.catch((error: { exitCode?: number }) => {
						if (error.exitCode !== 1) { throw error; }
						return undefined;
					});
				expect(!ps || ps.stdout.trim().startsWith('Z')).toBe(true);
				expect(await temporary.readdir('')).toStrictEqual([]);
				expect(await remote.git('for-each-ref')).toBe('');
			} finally {
				watchController.abort();
				await watcher.return?.();
				if (child.pid) {
					try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
				}
				await cli.closed;
			}
		});
	}
	test('kills an active pack group on a second signal', async () => {
		await using remote = await createGitFixture(undefined, ['--bare']);
		await using temporary = await createFixture();
		await using marker = await createFixture();
		const npmResult = await spawn('which', ['npm']);
		const npmPath = npmResult.stdout.trim();
		await fs.writeFile(marker.getPath('npm'), `#!${process.execPath}\nconst fs = require('node:fs'); const { spawn } = require('node:child_process'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(marker.getPath('group'))}, String(process.pid)); spawn(${JSON.stringify(npmPath)}, process.argv.slice(2), { stdio: 'inherit' }); setInterval(() => {}, 1000);`);
		await fs.chmod(marker.getPath('npm'), 0o755);
		await using fixture = await createGitFixture({
			'package.json': JSON.stringify({
				name: 'app',
				version: '1.0.0',
				scripts: { prepack: `"${process.execPath}" hook.cjs` },
			}),
			'hook.cjs': 'const net = require(\'node:net\'); const socket = net.connect(Number(process.env.SIGNAL_TEST_PORT), \'127.0.0.1\', () => socket.write(\'ready\')); process.on(\'SIGTERM\', () => socket.write(\'term\'));',
		}, ['--initial-branch=signal-twice']);
		await fixture.git('add', ['.']);
		await fixture.git('commit', ['-m', 'Initial commit']);
		await fixture.git('remote', ['add', 'origin', remote.path]);

		// Listen only after fixture setup, so a setup failure cannot leave the server open
		const server = net.createServer();
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Missing server address'); }
		const child = spawnChild(process.execPath, [path.resolve('dist/index.js')], {
			cwd: fixture.path,
			env: {
				...process.env,
				PATH: `${marker.path}${path.delimiter}${process.env.PATH}`,
				TMPDIR: temporary.path,
				SIGNAL_TEST_PORT: String(address.port),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const cli = monitorSignalChild(child);
		let connection: net.Socket | undefined;
		try {
			[connection] = await cli.waitFor('prepack connection', once(server, 'connection') as Promise<[net.Socket]>);
			await cli.waitFor('prepack ready data', once(connection, 'data'));
			const received = once(connection, 'data');
			child.kill('SIGTERM');
			const [message] = await cli.waitFor('prepack SIGTERM acknowledgment', received);
			// The group SIGTERM and npm's forwarded SIGTERM can both arrive and coalesce into one chunk
			expect(String(message)).toMatch(/^(?:term)+$/);
			expect(child.exitCode).toBe(null);
			expect(connection.destroyed).toBe(false);
			const closed = once(connection, 'close');
			expect(child.kill('SIGTERM')).toBe(true);
			const [code] = await Promise.all([
				cli.waitFor('CLI close after second SIGTERM', cli.closed, { allowExit: true }),
				cli.waitFor('prepack socket close', closed, { allowExit: true }),
			]);
			expect(code).toBe(143);
		} finally {
			// Stop accepting connections before destroying the captured one
			server.close();
			connection?.destroy();
			if (await marker.exists('group')) {
				try { process.kill(-Number(await marker.readFile('group', 'utf8')), 'SIGKILL'); } catch { /* Already exited. */ }
			}
			child.kill('SIGKILL');
			await cli.closed;
		}
	});
});
