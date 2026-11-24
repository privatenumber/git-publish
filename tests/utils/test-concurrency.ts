import os from 'node:os';

// tests/index.ts runs this many spec files at a time, and each spec group runs
// testConcurrency tests at a time. Most tests drive one subprocess chain at a time,
// so the product keeps about one test on each CPU.
export const specConcurrency = 2;

export const testConcurrency = Math.ceil(os.availableParallelism() / specConcurrency);
