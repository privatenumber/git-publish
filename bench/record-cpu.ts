import fs from 'node:fs';

// Preloaded into the CLI process to report its own CPU time, excluding subprocesses
const outputPath = process.env.GIT_PUBLISH_BENCH_CPU_FILE;
if (outputPath) {
	process.on('exit', () => {
		const { user, system } = process.cpuUsage();
		fs.writeFileSync(outputPath, String((user + system) / 1000));
	});
}
