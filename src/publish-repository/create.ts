import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn, { type Options as SpawnOptions } from 'nano-spawn';
import { getStdout } from '../utils/get-stdout.ts';
import { materializePublishGitConfig } from './git-config.ts';
import {
	getGitServerCommand, isLocalGitUrl, type PublishRemote,
} from './remote.ts';

export type PublishRepository = {
	repositoryPath: string;
	packWorktreePath: string;
	packTemporaryDirectory: string;
	gitOptions: SpawnOptions;
	pushRemoteNames: string[];
	fetchRemoteName: string;
	dispose(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

export const createPublishRepository = async ({
	sourceRepositoryPath,
	publishRemote,
}: {
	sourceRepositoryPath: string;
	publishRemote: PublishRemote;
}): Promise<PublishRepository> => {
	const sourceRepositoryOptions = { cwd: sourceRepositoryPath };
	const fetchRemoteName = 'publish-source';
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-'));
	const repositoryPath = path.join(temporaryDirectory, 'publish-worktree');
	const packWorktreePath = path.join(temporaryDirectory, 'pack-worktree');
	const packTemporaryDirectory = path.join(temporaryDirectory, 'pack');
	const gitEnvironment = {
		GIT_CONFIG_SYSTEM: path.join(temporaryDirectory, 'system-config'),
		GIT_CONFIG_GLOBAL: path.join(temporaryDirectory, 'global-config'),
	};
	const gitOptions = {
		cwd: repositoryPath,
		env: gitEnvironment,
	};
	const pushRemoteNames = publishRemote.pushUrls.map((_, index) => `publish-${index}`);
	let packWorktreeCreated = false;

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
		await spawn('git', ['clone', '--origin', fetchRemoteName, '--shared', '--no-checkout', sourceRepositoryPath, repositoryPath], { env: gitEnvironment });
		await spawn('git', ['remote', 'set-url', fetchRemoteName, publishRemote.fetchUrl], gitOptions);
		for (const [index, pushUrl] of publishRemote.pushUrls.entries()) {
			await spawn('git', ['remote', 'add', pushRemoteNames[index], pushUrl], gitOptions);
		}
		await materializePublishGitConfig({
			sourceRepositoryOptions,
			destinationRepositoryPath: repositoryPath,
			remote: publishRemote,
			fetchRemoteName,
			pushRemoteNames,
			systemConfigPath: gitEnvironment.GIT_CONFIG_SYSTEM,
			globalConfigPath: gitEnvironment.GIT_CONFIG_GLOBAL,
		});
		if (isLocalGitUrl(publishRemote.fetchUrl)) {
			const uploadPack = await getStdout(spawn('git', ['config', '--get', `remote.${fetchRemoteName}.uploadpack`], gitOptions)).catch(() => 'git-upload-pack');
			await spawn('git', ['config', `remote.${fetchRemoteName}.uploadpack`, getGitServerCommand(publishRemote.fetchUrl, uploadPack)], gitOptions);
		}
		for (const [index, pushUrl] of publishRemote.pushUrls.entries()) {
			if (!isLocalGitUrl(pushUrl)) {
				continue;
			}

			const receivePack = await getStdout(spawn('git', ['config', '--get', `remote.${pushRemoteNames[index]}.receivepack`], gitOptions)).catch(() => 'git-receive-pack');
			await spawn('git', ['config', `remote.${pushRemoteNames[index]}.receivepack`, getGitServerCommand(pushUrl, receivePack)], gitOptions);
		}
		packWorktreeCreated = true;
		await spawn('git', ['worktree', 'add', '--force', packWorktreePath, 'HEAD'], gitOptions);
	} catch (error) {
		try {
			await dispose();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], 'Failed to create temporary publish repository.');
		}

		throw error;
	}

	return {
		repositoryPath,
		packWorktreePath,
		packTemporaryDirectory,
		gitOptions,
		pushRemoteNames,
		fetchRemoteName,
		dispose,
		[Symbol.asyncDispose]: dispose,
	};
};
