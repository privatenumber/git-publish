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
	packWorktreePath: string;
	packTemporaryDirectory: string;
	gitOptions: SpawnOptions;
	pushRemoteNames: string[];
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
	const pushRemoteNames = publishRemote.pushUrls.map((_, index) => `publish-${index}`);
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
		for (const [index, pushUrl] of publishRemote.pushUrls.entries()) {
			await spawnAbortable('git', ['remote', 'add', pushRemoteNames[index], pushUrl], {
				...gitOptions,
				signal,
			});
		}
		await materializePublishGitConfig({
			sourceRepositoryOptions,
			destinationRepositoryPath: publishRepositoryPath,
			remote: publishRemote,
			fetchRemoteName,
			pushRemoteNames,
			systemConfigPath: gitEnvironment.GIT_CONFIG_SYSTEM,
			globalConfigPath: gitEnvironment.GIT_CONFIG_GLOBAL,
		});
		await configurePublishTransport({
			gitOptions,
			publishRemote,
			fetchRemoteName,
			pushRemoteNames,
		});
		packWorktreeCreated = true;
		await spawnAbortable('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--force', '--detach', packWorktreePath, sourceCommitId], {
			...gitOptions,
			signal,
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
		packWorktreePath,
		packTemporaryDirectory,
		gitOptions,
		pushRemoteNames,
		fetchRemoteName,
		dispose,
	};
};
