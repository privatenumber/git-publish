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
	sourceRepositoryPath: string;
	packWorktreePath: string;
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
	const fetchRemoteName = 'publish-source';
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-'));
	const publishRepositoryPath = path.join(temporaryDirectory, 'publish-repository');
	const packWorktreePath = path.join(temporaryDirectory, 'pack-worktree');
	const packTemporaryDirectory = path.join(temporaryDirectory, 'pack');
	const gitEnvironment = {
		GIT_CONFIG_SYSTEM: path.join(temporaryDirectory, 'system-config'),
		GIT_CONFIG_GLOBAL: path.join(temporaryDirectory, 'global-config'),
	};
	const gitOptions = {
		cwd: publishRepositoryPath,
		env: gitEnvironment,
	};
	const pushRemoteName = `git-publish-${randomUUID()}`;
	let packWorktreeCreated = false;

	let disposal: Promise<void> | undefined;
	const dispose = () => {
		disposal ??= (async () => {
			const cleanupErrors: unknown[] = [];
			if (packWorktreeCreated) {
				await spawn('git', ['worktree', 'remove', '--force', packWorktreePath], gitOptions).catch(error => cleanupErrors.push(error));
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
			// Git applies insteadOf, but not pushInsteadOf, to an explicit pushurl.
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
		await spawnAbortable('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--force', '--detach', packWorktreePath, sourceCommitId], {
			...gitOptions,
			signal,
		});
		packWorktreeCreated = true;
	} catch (error) {
		try {
			await dispose();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], 'Failed to create temporary publish repository.');
		}

		throw error;
	}

	return {
		sourceRepositoryPath,
		packWorktreePath,
		packTemporaryDirectory,
		gitOptions,
		pushRemoteName,
		fetchRemoteName,
		dispose,
	};
};
