import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from 'cleye';

const argv = cli({
	name: 'skills',
	flags: {
		install: {
			type: String,
			description: 'Copy the skill into <directory>/git-publish instead of printing it',
			placeholder: '<directory>',
		},
	},
	help: {
		description: 'Print the agent skill bundled with git-publish, or install it into an agent skills directory.',
		examples: [
			'git-publish skills',
			'git-publish skills --install ~/.agents/skills',
			'git-publish skills --install ~/.claude/skills',
			'git-publish skills --install .agents/skills',
		],
	},
});

// Bundled command chunks have a different depth than the source file.
const findSkillDirectory = async () => {
	let directory = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		const skillDirectory = path.join(directory, 'skills', 'git-publish');
		try {
			await fs.access(path.join(skillDirectory, 'SKILL.md'));
			return skillDirectory;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}

		const parent = path.dirname(directory);
		if (parent === directory) {
			throw new Error('Could not find the bundled git-publish skill');
		}
		directory = parent;
	}
};

const skillDirectory = await findSkillDirectory();

if (argv.flags.install === undefined) {
	process.stdout.write(await fs.readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8'));
} else {
	// Shells do not expand ~ in --install=~/...
	const directory = argv.flags.install.replace(/^~(?=$|[/\\])/, os.homedir());
	const destination = path.resolve(directory, 'git-publish');
	await fs.cp(skillDirectory, destination, { recursive: true });
	process.stderr.write(`Installed the git-publish skill to ${destination}\n`);
}
