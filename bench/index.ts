import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import spawn from 'nano-spawn';
import { createFixture, type FileTree } from 'fs-fixture';

const { values: options } = parseArgs({
	options: {
		packages: {
			type: 'string',
			default: '20',
		},
		runs: {
			type: 'string',
			default: '3',
		},
		'package-manager': {
			type: 'string',
			default: 'pnpm',
		},
		scenario: {
			type: 'string',
			multiple: true,
		},
		cli: {
			type: 'string',
			multiple: true,
			default: [path.join(import.meta.dirname, '../dist/index.js')],
		},
		json: { type: 'string' },
	},
});

const scenarioNames = ['plan', 'publish', 'republish', 'select'];
const packageCount = Number(options.packages);
const runs = Number(options.runs);
const packageManager = options['package-manager'];
const cliPaths = options.cli.map(cliPath => path.resolve(cliPath));
const selectedNames = options.scenario ?? scenarioNames;
if (!Number.isInteger(packageCount) || packageCount < 3) {
	throw new Error('--packages must be an integer of at least 3');
}
if (!Number.isInteger(runs) || runs < 1) {
	throw new Error('--runs must be a positive integer');
}
if (packageManager !== 'pnpm' && packageManager !== 'npm') {
	throw new Error('--package-manager must be pnpm or npm');
}
const unknownScenario = selectedNames.find(name => !scenarioNames.includes(name));
if (unknownScenario) {
	throw new Error(`Unknown scenario ${JSON.stringify(unknownScenario)}. Choose from: ${scenarioNames.join(', ')}`);
}
if (new Set(cliPaths).size !== cliPaths.length) {
	throw new Error('Each --cli path must be different');
}
for (const cliPath of cliPaths) {
	await fs.access(cliPath).catch(() => {
		throw new Error(`CLI not found at ${cliPath}. Run pnpm build first.`);
	});
}

await using scratch = await createFixture({
	'.gitconfig': '[user]\n\tname = bench\n\temail = bench@example.com\n[init]\n\tdefaultBranch = main\n',
});
// Isolates the fixture and the measured CLI from the user's Git configuration. HOME also
// covers local push and fetch, which git-publish runs with GIT_CONFIG_GLOBAL unset.
const environment: Record<string, string | undefined> = {
	...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('GIT_')).map(key => [key, undefined])),
	HOME: scratch.path,
	XDG_CONFIG_HOME: scratch.path,
	GIT_CONFIG_GLOBAL: scratch.getPath('.gitconfig'),
	GIT_CONFIG_NOSYSTEM: '1',
};
const cpuFile = scratch.getPath('cpu.txt');
const resultFile = scratch.getPath('result.json');

// One library per six packages, at least one; every app depends on one or two libraries
const libraryCount = Math.max(1, Math.round(packageCount / 6));
const createPackageFiles = (name: string, dependencies: string[]): FileTree => {
	const dist: FileTree = {};
	for (let index = 0; index < 20; index += 1) {
		dist[`chunk-${index}.js`] = `export const value${index} = ${JSON.stringify(name.repeat(200))};\n`;
	}
	return {
		'package.json': JSON.stringify({
			name,
			version: '1.0.0',
			type: 'module',
			files: ['dist'],
			exports: './dist/chunk-0.js',
			// npm has no workspace: protocol and links matching plain ranges instead
			dependencies: Object.fromEntries(dependencies.map(dependency => [dependency, packageManager === 'npm' ? '1.0.0' : 'workspace:*'])),
		}),
		'README.md': `# ${name}\n`,
		dist,
	};
};

const libraries = Array.from({ length: libraryCount }, (_, index) => `lib-${index}`);
const apps = new Map(Array.from({ length: packageCount - libraryCount }, (_, index) => {
	const dependencies = [libraries[index % libraryCount]!];
	if (index % 2 === 1 && libraryCount > 1) {
		dependencies.push(libraries[(index + 1) % libraryCount]!);
	}
	return [`app-${index}`, dependencies];
}));
const workspaceFiles: FileTree = {
	'package.json': JSON.stringify({
		name: 'bench-root',
		private: true,
		workspaces: ['libs/*', 'apps/*'],
	}),
	// Untracked like real build output, so publication runs copy dist into the pack checkout
	'.gitignore': 'node_modules\ndist\n',
	libs: Object.fromEntries(libraries.map(name => [name, createPackageFiles(name, [])])),
	apps: Object.fromEntries([...apps].map(([name, dependencies]) => [
		name,
		createPackageFiles(name, dependencies),
	])),
};
// git-publish detects pnpm from this file before any other marker
if (packageManager === 'pnpm') {
	workspaceFiles['pnpm-workspace.yaml'] = 'packages:\n  - libs/*\n  - apps/*\n';
}

// Bound before setup, so a failed install or commit still removes it
await using workspace = await createFixture(workspaceFiles);
const workspaceOptions = {
	cwd: workspace.path,
	env: environment,
};
await spawn('git', ['init', '-q'], workspaceOptions);
await spawn(packageManager, ['install'], workspaceOptions);
await spawn('git', ['add', '.'], workspaceOptions);
await spawn('git', ['commit', '-q', '-m', 'Initial commit'], workspaceOptions);

let remoteCount = 0;
const createRemote = async () => {
	remoteCount += 1;
	const remotePath = scratch.getPath(`remote-${remoteCount}.git`);
	await spawn('git', ['init', '-q', '--bare', remotePath], { env: environment });
	return pathToFileURL(remotePath).href;
};

type Result = {
	packages: {
		name: string;
		reused: boolean;
	}[];
};

// Runs the CLI once and, for a publication, checks that it published exactly the expected packages
const runCli = async (
	cliPath: string,
	args: string[],
	expected?: {
		names: string[];
		reused: boolean;
	},
) => {
	await fs.rm(resultFile, { force: true });
	const start = performance.now();
	await spawn(process.execPath, [
		'--import',
		path.join(import.meta.dirname, 'record-cpu.ts'),
		cliPath,
		...args,
		...(expected ? ['--json', resultFile] : []),
	], {
		cwd: workspace.path,
		env: {
			...environment,
			GIT_PUBLISH_BENCH_CPU_FILE: cpuFile,
		},
	});
	const wall = performance.now() - start;
	const cpu = Number(await fs.readFile(cpuFile, 'utf8'));
	if (expected) {
		const result = JSON.parse(await fs.readFile(resultFile, 'utf8')) as Result;
		const published = result.packages.map(item => item.name).sort().join(', ');
		if (published !== expected.names.slice().sort().join(', ')) {
			throw new Error(`${cliPath} published ${published}, expected ${expected.names.slice().sort().join(', ')}`);
		}
		const mismatched = result.packages
			.filter(item => item.reused !== expected.reused)
			.map(item => item.name);
		if (mismatched.length > 0) {
			throw new Error(`${cliPath} ${expected.reused ? 'created new commits for' : 'reused commits for'} ${mismatched.join(', ')}`);
		}
	}
	return {
		wall,
		cpu,
	};
};

type Cli = {
	cliPath: string;
	populatedRemote?: string;
};

const allPackages = [...libraries, ...apps.keys()];
const selectedPackages = ['app-1', ...apps.get('app-1')!];

const scenarios: {
	name: string;
	description: string;
	run: (cli: Cli) => ReturnType<typeof runCli>;
	published: number;
}[] = [
	{
		name: 'plan',
		description: 'Discover the workspace and plan every package (--dry)',
		run: async ({ cliPath }) => runCli(cliPath, ['--dry', '--remote', await createRemote()]),
		published: 0,
	},
	{
		name: 'publish',
		description: 'First publish of every package to an empty remote',
		run: async ({ cliPath }) => runCli(cliPath, ['--remote', await createRemote()], {
			names: allPackages,
			reused: false,
		}),
		published: allPackages.length,
	},
	{
		name: 'republish',
		description: 'Publish every package again with no changes',
		run: async ({ cliPath, populatedRemote }) => runCli(cliPath, ['--remote', populatedRemote!], {
			names: allPackages,
			reused: true,
		}),
		published: allPackages.length,
	},
	{
		name: 'select',
		description: 'Publish one app and its libraries to an empty remote',
		run: async ({ cliPath }) => runCli(cliPath, ['app-1', '--remote', await createRemote()], {
			names: selectedPackages,
			reused: false,
		}),
		published: selectedPackages.length,
	},
];

const median = (values: number[]) => {
	const sorted = values.slice().sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(2)}s`;

const clis: Cli[] = [];
for (const cliPath of cliPaths) {
	const cli: Cli = { cliPath };
	// A remote per CLI keeps republish a no-change run even if builds pack differently
	if (selectedNames.includes('republish')) {
		cli.populatedRemote = await createRemote();
		await runCli(cliPath, ['--remote', cli.populatedRemote], {
			names: allPackages,
			reused: false,
		});
	}
	clis.push(cli);
}

const [loadAverage] = os.loadavg();
console.log(`git-publish bench: ${packageCount} packages (${libraryCount} libraries), ${packageManager}, ${runs} runs after 1 warmup`);
console.log(`Node.js ${process.version}, ${os.availableParallelism()} CPUs, load average ${loadAverage!.toFixed(1)} at start`);

const results = [];
for (const scenario of scenarios.filter(({ name }) => selectedNames.includes(name))) {
	console.log(`\n${scenario.name}: ${scenario.description}`);
	const samples = new Map(clis.map(cli => [cli, [] as Awaited<ReturnType<typeof runCli>>[]]));
	for (let round = 0; round <= runs; round += 1) {
		// Rotate the order every round so no build always runs first
		for (let offset = 0; offset < clis.length; offset += 1) {
			const cli = clis[(round + offset) % clis.length]!;
			const sample = await scenario.run(cli);
			if (round > 0) {
				samples.get(cli)!.push(sample);
			}
		}
	}
	for (const cli of clis) {
		const cliSamples = samples.get(cli)!;
		const wall = cliSamples.map(sample => sample.wall);
		const result = {
			scenario: scenario.name,
			cli: cli.cliPath,
			published: scenario.published,
			wallMedian: median(wall),
			wallMin: Math.min(...wall),
			wallMax: Math.max(...wall),
			cpuMedian: median(cliSamples.map(sample => sample.cpu)),
		};
		results.push(result);
		const perPackage = result.published > 0 ? `  ${seconds(result.wallMedian / result.published)} per package` : '';
		console.log(`  ${seconds(result.wallMedian).padStart(7)} median (${seconds(result.wallMin)} to ${seconds(result.wallMax)})  CLI CPU ${seconds(result.cpuMedian)}${perPackage}  ${cli.cliPath}`);
	}
}

if (options.json) {
	await fs.writeFile(options.json, `${JSON.stringify({
		packages: packageCount,
		libraries: libraryCount,
		packageManager,
		runs,
		node: process.version,
		platform: `${process.platform}-${process.arch}`,
		cpus: os.availableParallelism(),
		loadAverage,
		results,
	}, null, '\t')}\n`);
}
