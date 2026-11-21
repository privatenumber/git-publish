import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { spawnAbortable } from '../utils/spawn-abortable.ts';
import { getTransportConfigParameters, materializePublishGitConfig } from './git-config.ts';
import {
	configurePublishTransport, type PublishRemote,
} from './remote.ts';

export type PublishEndpoint = {
	name: string;
	url: string;
};

export type PublishRepository = {
	packWorktreePath: string;
	packTemporaryDirectory: string;
	gitOptions: SpawnOptions;
	history: PublishEndpoint;
	push: PublishEndpoint;
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
	const push: PublishEndpoint = {
		name: 'publish',
		url: publishRemote.pushUrl,
	};
	const history = publishRemote.historyUrl === push.url
		? push
		: {
			name: 'publish-source',
			url: publishRemote.historyUrl,
		};
	const transportConfigParameters = await getTransportConfigParameters(sourceRepositoryOptions);
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-'));
	const publishRepositoryPath = path.join(temporaryDirectory, 'publish-repository');
	const packWorktreePath = path.join(temporaryDirectory, 'pack-worktree');
	const packTemporaryDirectory = path.join(temporaryDirectory, 'pack');
	const gitEnvironment = {
		GIT_CONFIG_SYSTEM: path.join(temporaryDirectory, 'system-config'),
		GIT_CONFIG_GLOBAL: path.join(temporaryDirectory, 'global-config'),
		GIT_CONFIG_COUNT: undefined,
		GIT_CONFIG_PARAMETERS: transportConfigParameters,
	};
	const gitOptions = {
		cwd: publishRepositoryPath,
		env: gitEnvironment,
	};
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
		await spawnAbortable('git', ['clone', '--origin', history.name, '--shared', '--no-checkout', sourceRepositoryPath, publishRepositoryPath], {
			env: gitEnvironment,
			signal,
		});
		await spawnAbortable('git', ['remote', 'set-url', history.name, history.url], {
			...gitOptions,
			signal,
		});
		if (history !== push) {
			await spawnAbortable('git', ['remote', 'add', push.name, push.url], {
				...gitOptions,
				signal,
			});
		}
		await spawnAbortable('git', ['config', `remote.${push.name}.pushurl`, push.url], {
			...gitOptions,
			signal,
		});
		const packRewriteConfig = await materializePublishGitConfig({
			sourceRepositoryOptions,
			destinationRepositoryPath: publishRepositoryPath,
			remote: publishRemote,
			fetchRemoteName: history.name,
			pushRemoteName: push.name,
			systemConfigPath: gitEnvironment.GIT_CONFIG_SYSTEM,
			globalConfigPath: gitEnvironment.GIT_CONFIG_GLOBAL,
		});
		await configurePublishTransport({
			gitOptions,
			publishRemote,
			fetchRemoteName: history.name,
			pushRemoteName: push.name,
		});
		await spawnAbortable('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--force', '--detach', packWorktreePath, sourceCommitId], {
			...gitOptions,
			signal,
		});
		packWorktreeCreated = true;
		if (packRewriteConfig) {
			await spawnAbortable('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
				...gitOptions,
				signal,
			});
			const { stdout: configPath } = await spawnAbortable('git', [
				'rev-parse', '--git-path', 'config.worktree',
			], {
				...gitOptions,
				cwd: packWorktreePath,
				signal,
			});
			await fs.writeFile(path.resolve(packWorktreePath, configPath), packRewriteConfig);
		}
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
		history,
		push,
		dispose,
	};
};
