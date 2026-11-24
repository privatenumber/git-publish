import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { spawnAbortable } from '../utils/spawn-abortable.ts';
import { materializePublishGitConfig } from './git-config.ts';
import {
	configurePublishTransport, type PublishRemote,
} from './remote.ts';

export type PublishRepository = {
	withPackWorktree<T>(signal: AbortSignal, pack: (worktreePath: string) => Promise<T>): Promise<T>;
	packTemporaryDirectory: string;
	gitOptions: SpawnOptions;
	pushRemoteName: string;
	fetchRemoteName: string;
	dispose(): Promise<void>;
};

export const createPublishRepository = async ({
	sourceRepositoryPath,
	publishRemote,
	sourceCommitId,
	signal,
}: {
	sourceRepositoryPath: string;
	publishRemote: PublishRemote;
	sourceCommitId: string;
	signal: AbortSignal;
}): Promise<PublishRepository> => {
	const sourceRepositoryOptions = { cwd: sourceRepositoryPath };
	// Random names keep inherited remote.<name>.* config from redirecting the internal remotes
	const remoteId = randomUUID();
	const fetchRemoteName = `git-publish-source-${remoteId}`;
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-'));
	const publishRepositoryPath = path.join(temporaryDirectory, 'publish-repository');
	const packTemporaryDirectory = path.join(temporaryDirectory, 'pack');
	const gitEnvironment = {
		GIT_CONFIG_SYSTEM: path.join(temporaryDirectory, 'system-config'),
		GIT_CONFIG_GLOBAL: path.join(temporaryDirectory, 'global-config'),
	};
	const gitOptions = {
		cwd: publishRepositoryPath,
		env: gitEnvironment,
	};
	const pushRemoteName = `git-publish-${remoteId}`;
	const packWorktrees: string[] = [];
	const idlePackWorktrees: string[] = [];
	let nextPackWorktree = 0;
	let worktreeCreation = Promise.resolve();

	let disposal: Promise<void> | undefined;
	const dispose = () => {
		disposal ??= (async () => {
			const cleanupErrors: unknown[] = [];
			for (const worktreePath of packWorktrees) {
				await spawn('git', ['worktree', 'remove', '--force', worktreePath], gitOptions).catch(error => cleanupErrors.push(error));
			}
			await fs.rm(temporaryDirectory, {
				recursive: true,
				force: true,
			}).catch(error => cleanupErrors.push(error));
			if (cleanupErrors.length > 0) {
				throw new AggregateError(cleanupErrors, 'Failed to clean up temporary publish resources.');
			}
		})();
		return disposal;
	};

	try {
		// The isolated client can hold credentials copied from the source remote.
		await fs.chmod(temporaryDirectory, 0o700);
		await spawnAbortable('git', ['clone', '--origin', fetchRemoteName, '--shared', '--no-checkout', sourceRepositoryPath, publishRepositoryPath], {
			env: gitEnvironment,
			signal,
		});
		await spawnAbortable('git', ['remote', 'set-url', fetchRemoteName, publishRemote.historyUrl], {
			...gitOptions,
			signal,
		});
		await spawnAbortable('git', ['remote', 'add', pushRemoteName, publishRemote.pushUrl], {
			...gitOptions,
			signal,
		});
		if (publishRemote.hasExplicitPushUrl) {
			// Git applies insteadOf, but not pushInsteadOf, to an explicit pushurl
			await spawnAbortable('git', ['remote', 'set-url', '--push', pushRemoteName, publishRemote.pushUrl], {
				...gitOptions,
				signal,
			});
		}
		await materializePublishGitConfig({
			sourceRepositoryOptions,
			destinationRepositoryPath: publishRepositoryPath,
			remote: publishRemote,
			fetchRemoteName,
			pushRemoteName,
			systemConfigPath: gitEnvironment.GIT_CONFIG_SYSTEM,
			globalConfigPath: gitEnvironment.GIT_CONFIG_GLOBAL,
		});
		await configurePublishTransport({
			gitOptions,
			publishRemote,
			fetchRemoteName,
			pushRemoteName,
		});
	} catch (error) {
		try {
			await dispose();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], 'Failed to create temporary publish repository.');
		}

		throw error;
	}

	return {
		async withPackWorktree(packSignal, pack) {
			// The caller bounds concurrent leases. Reuse an idle checkout before creating one.
			let worktreePath = idlePackWorktrees.pop();
			if (worktreePath === undefined) {
				worktreePath = path.join(temporaryDirectory, `pack-worktree-${nextPackWorktree}`);
				nextPackWorktree += 1;
				const checkout = worktreePath;
				// Git scans existing registrations during add, including ones still being written.
				const creation = worktreeCreation.then(async () => {
					await spawnAbortable('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--force', '--detach', checkout, sourceCommitId], {
						...gitOptions,
						signal: packSignal,
					});
					packWorktrees.push(checkout);
				});
				worktreeCreation = creation.catch(() => {});
				await creation;
			}
			try {
				const worktreeOptions = {
					cwd: worktreePath,
					env: gitEnvironment,
					signal: packSignal,
				};
				await spawnAbortable('git', ['-c', 'core.hooksPath=/dev/null', 'reset', '--hard', sourceCommitId], worktreeOptions);
				await spawnAbortable('git', ['-c', 'core.hooksPath=/dev/null', 'clean', '-fdx'], worktreeOptions);
				return await pack(worktreePath);
			} finally {
				idlePackWorktrees.push(worktreePath);
			}
		},
		packTemporaryDirectory,
		gitOptions,
		pushRemoteName,
		fetchRemoteName,
		dispose,
	};
};
