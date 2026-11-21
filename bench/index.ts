import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import spawn from 'nano-spawn';
import { createFixture, type FileTree } from 'fs-fixture';
import { cli } from 'cleye';
import { Integer, OneOf } from 'cleye/formats';

const scenarioNames = ['plan', 'publish', 'republish', 'select'] as const;

const IntegerAtLeast = (minimum: number) => (value: string) => {
	const number = Integer(value);
	if (number < minimum) {
		throw new Error(`Expected an integer of at least ${minimum} (got: ${number})`);
	}
	return number;
};

// cleye parses a flag with no value as an empty string
const Path = (value: string) => {
	if (value === '') {
		throw new Error('Expected a path');
	}
	return value;
};

const argv = cli({
	name: 'bench',
	strictFlags: true,
	flags: {
		packages: {
			// select publishes app-1, which needs at least one library and two apps
			type: IntegerAtLeast(3),
			placeholder: '<count>',
			description: 'Number of packages in the generated workspace',
			default: 20,
		},
		runs: {
			type: IntegerAtLeast(1),
			placeholder: '<count>',
			description: 'Timed runs per scenario, after one warmup run',
			default: 3,
		},
		packageManager: {
			type: OneOf(['pnpm', 'npm']),
			description: 'Package manager that installs the workspace',
			default: 'pnpm',
		},
		scenario: {
			type: [OneOf(scenarioNames)],
			description: 'Scenario to run; repeat to run several (default: all)',
		},
		cli: {
			type: [Path],
			placeholder: '<path>',
			description: 'Built CLI to time; repeat to compare builds (default: dist/index.js)',
		},
		json: {
			type: Path,
			placeholder: '<path>',
			description: 'Write the results as JSON',
		},
	},
});

if (argv._.length > 0) {
	throw new Error(`Unexpected arguments: ${argv._.join(' ')}. Repeat the flag for each value, as in --scenario plan --scenario publish`);
}
const { flags } = argv;
const packageCount = flags.packages;
const { runs, packageManager } = flags;
const cliPaths = (flags.cli.length > 0 ? flags.cli : [path.join(import.meta.dirname, '../dist/index.js')])
	.map(cliPath => path.resolve(cliPath));
const selectedNames: readonly string[] = flags.scenario.length > 0 ? flags.scenario : scenarioNames;
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
// Child processes inherit only PATH, so user settings such as npm_config_* or NODE_OPTIONS
// cannot change the runs. HOME holds the Git configuration because git-publish runs local
// push and fetch with GIT_CONFIG_GLOBAL unset.
const environment: Record<string, string | undefined> = {
	...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
	PATH: process.env.PATH,
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
// git-publish detects pnpm from this file before the markers of other package managers
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

// Runs the CLI once and checks that it planned or published exactly the expected packages
const runCli = async (
	cliPath: string,
	args: string[],
	expected: {
		names: string[];
		check: 'planned' | 'published' | 'reused';
	},
) => {
	await fs.rm(resultFile, { force: true });
	const start = performance.now();
	const { stdout } = await spawn(process.execPath, [
		'--import',
		path.join(import.meta.dirname, 'record-cpu.ts'),
		cliPath,
		...args,
		...(expected.check === 'planned' ? [] : ['--json', resultFile]),
	], {
		cwd: workspace.path,
		env: {
			...environment,
			GIT_PUBLISH_BENCH_CPU_FILE: cpuFile,
		},
	});
	const wall = performance.now() - start;
	const cpu = Number(await fs.readFile(cpuFile, 'utf8'));
	const result = expected.check === 'planned'
		? undefined
		: JSON.parse(await fs.readFile(resultFile, 'utf8')) as Result;
	// A dry run prints one "- <name> → <branch>" line per planned package
	const names = result
		? result.packages.map(item => item.name)
		: [...stdout.matchAll(/^- (\S+) → /gm)].map(match => match[1]!);
	const actualNames = names.sort().join(', ');
	const expectedNames = expected.names.slice().sort().join(', ');
	if (actualNames !== expectedNames) {
		throw new Error(`${cliPath} ${expected.check} [${actualNames}], expected [${expectedNames}]`);
	}
	const mismatched = result?.packages
		.filter(item => item.reused !== (expected.check === 'reused'))
		.map(item => item.name) ?? [];
	if (mismatched.length > 0) {
		throw new Error(`${cliPath} has the wrong reused flag for ${mismatched.join(', ')}, expected ${expected.check}`);
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
	getArguments: (cli: Cli) => Promise<string[]>;
	names: string[];
	check: 'planned' | 'published' | 'reused';
}[] = [
	{
		name: 'plan',
		description: 'Discover the workspace and plan every package (--dry)',
		getArguments: async () => ['--dry', '--remote', await createRemote()],
		names: allPackages,
		check: 'planned',
	},
	{
		name: 'publish',
		description: 'First publish of every package to an empty remote',
		getArguments: async () => ['--remote', await createRemote()],
		names: allPackages,
		check: 'published',
	},
	{
		name: 'republish',
		description: 'Publish every package again with no changes',
		getArguments: async ({ populatedRemote }) => ['--remote', populatedRemote!],
		names: allPackages,
		check: 'reused',
	},
	{
		name: 'select',
		description: 'Publish one app and its libraries to an empty remote',
		getArguments: async () => ['app-1', '--remote', await createRemote()],
		names: selectedPackages,
		check: 'published',
	},
];

const median = (values: number[]) => {
	const sorted = values.slice().sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(2)}s`;

const builds: Cli[] = [];
for (const cliPath of cliPaths) {
	const build: Cli = { cliPath };
	// A remote per CLI keeps republish a no-change run even if builds pack differently
	if (selectedNames.includes('republish')) {
		build.populatedRemote = await createRemote();
		await runCli(cliPath, ['--remote', build.populatedRemote], {
			names: allPackages,
			check: 'published',
		});
	}
	builds.push(build);
}

const [loadAverage] = os.loadavg();
console.log(`git-publish bench: ${packageCount} packages (${libraryCount} libraries), ${packageManager}, ${runs} runs after 1 warmup`);
console.log(`Node.js ${process.version}, ${os.availableParallelism()} CPUs, load average ${loadAverage!.toFixed(1)} at start`);

const results = [];
for (const scenario of scenarios.filter(({ name }) => selectedNames.includes(name))) {
	console.log(`\n${scenario.name}: ${scenario.description}`);
	const samples = new Map(builds.map(build => [build, [] as Awaited<ReturnType<typeof runCli>>[]]));
	for (let round = 0; round <= runs; round += 1) {
		// Rotate the order every round so no build always runs first
		for (let offset = 0; offset < builds.length; offset += 1) {
			const build = builds[(round + offset) % builds.length]!;
			const sample = await runCli(build.cliPath, await scenario.getArguments(build), scenario);
			if (round > 0) {
				samples.get(build)!.push(sample);
			}
		}
	}
	for (const build of builds) {
		const buildSamples = samples.get(build)!;
		const wall = buildSamples.map(sample => sample.wall);
		const result = {
			scenario: scenario.name,
			cli: build.cliPath,
			published: scenario.check === 'planned' ? 0 : scenario.names.length,
			wallMedian: median(wall),
			wallMin: Math.min(...wall),
			wallMax: Math.max(...wall),
			cpuMedian: median(buildSamples.map(sample => sample.cpu)),
		};
		results.push(result);
		const perPackage = result.published > 0 ? `  ${seconds(result.wallMedian / result.published)} per package` : '';
		console.log(`  ${seconds(result.wallMedian).padStart(7)} median (${seconds(result.wallMin)} to ${seconds(result.wallMax)})  CLI CPU ${seconds(result.cpuMedian)}${perPackage}  ${build.cliPath}`);
	}
}

if (flags.json) {
	await fs.writeFile(flags.json, `${JSON.stringify({
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
