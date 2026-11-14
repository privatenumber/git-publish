import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { materializeSourceGitConfig, materializeRemoteGitConfig, type GitConfigEntry } from './git-config.ts';
import {
	configurePublishTransport, type PublishRemote,
} from './remote.ts';

export type PublishRepository = {
	packWorktreePath: string;
	packTemporaryDirectory: string;
	gitOptions: SpawnOptions;
	fetchRemoteName: string;
	temporaryDirectory: string;
	remoteConfig: GitConfigEntry[];
	dispose(): Promise<void>;
};

export type ConfiguredPublishRepository = PublishRepository & { pushRemoteNames: string[] };

export const createPublishRepository = async ({
	sourceRepositoryPath,
	sourceCommitId,
}: {
	sourceRepositoryPath: string;
	sourceCommitId: string;
}): Promise<PublishRepository> => {
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
	let packWorktreeCreated = false;
	let remoteConfig: GitConfigEntry[];

	const dispose = async () => {
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
	};

	try {
		// The isolated client can hold credentials copied from the source remote.
		await fs.chmod(temporaryDirectory, 0o700);
		await spawn('git', ['clone', '--origin', fetchRemoteName, '--shared', '--no-checkout', sourceRepositoryPath, publishRepositoryPath], { env: gitEnvironment });
		remoteConfig = await materializeSourceGitConfig({
			sourceRepositoryOptions: { cwd: sourceRepositoryPath },
			destinationRepositoryPath: publishRepositoryPath,
			systemConfigPath: gitEnvironment.GIT_CONFIG_SYSTEM,
			globalConfigPath: gitEnvironment.GIT_CONFIG_GLOBAL,
		});
		packWorktreeCreated = true;
		await spawn('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--force', '--detach', packWorktreePath, sourceCommitId], gitOptions);
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
		fetchRemoteName,
		temporaryDirectory,
		remoteConfig,
		dispose,
	};
};

export const configurePublishRemotes = async (
	repository: PublishRepository,
	publishRemote: PublishRemote,
): Promise<ConfiguredPublishRepository> => {
	const { gitOptions, fetchRemoteName, temporaryDirectory } = repository;
	const pushRemoteNames = publishRemote.pushUrls.map((_, index) => `publish-${index}`);
	await spawn('git', ['remote', 'set-url', fetchRemoteName, publishRemote.historyUrl], gitOptions);
	for (const [index, pushUrl] of publishRemote.pushUrls.entries()) {
		await spawn('git', ['remote', 'add', pushRemoteNames[index], pushUrl], gitOptions);
	}
	await materializeRemoteGitConfig({
		sourceConfig: repository.remoteConfig,
		destinationRepositoryPath: path.join(temporaryDirectory, 'publish-repository'),
		remote: publishRemote,
		fetchRemoteName,
		pushRemoteNames,
	});
	await configurePublishTransport({
		gitOptions,
		publishRemote,
		fetchRemoteName,
		pushRemoteNames,
	});
	return {
		...repository,
		pushRemoteNames,
	};
};
