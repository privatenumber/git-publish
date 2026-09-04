import { setTimeout } from 'node:timers/promises';
import { describe, test, expect } from 'manten';
import {
	runDependencyGraph, type GraphNode,
} from '../../src/publish-repository/run-graph.ts';

const waitFor = async (condition: () => boolean, message: string) => {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > 1000) {
			throw new Error(message);
		}
		await setTimeout(1);
	}
};

describe('Dependency graph runner', () => {
	test('relays dependency results up a linear chain', async () => {
		const order: string[] = [];
		const nodes: GraphNode<string, string>[] = [
			{
				key: 'a',
				value: 'a',
				dependencies: [],
			},
			{
				key: 'b',
				value: 'b',
				dependencies: ['a'],
			},
			{
				key: 'c',
				value: 'c',
				dependencies: ['b'],
			},
		];
		const results = await runDependencyGraph(nodes, async (node, dependencyResults) => {
			order.push(node.key);
			return `${node.key}<-[${[...dependencyResults.entries()].map(([key, result]) => `${key}=${result}`).join(',')}]`;
		});

		expect(order).toStrictEqual(['a', 'b', 'c']);
		expect(results.get('a')).toBe('a<-[]');
		expect(results.get('b')).toBe('b<-[a=a<-[]]');
		expect(results.get('c')).toBe('c<-[b=b<-[a=a<-[]]]');
	});

	test('runs diamond dependencies concurrently without duplicating work', async () => {
		const started = {
			a: false,
			b: false,
		};
		let coreRuns = 0;
		const order: string[] = [];
		const results = await runDependencyGraph<string, string, string>([
			{
				key: 'core',
				value: 'core',
				dependencies: [],
			},
			{
				key: 'a',
				value: 'a',
				dependencies: ['core'],
			},
			{
				key: 'b',
				value: 'b',
				dependencies: ['core'],
			},
			{
				key: 'app',
				value: 'app',
				dependencies: ['a', 'b'],
			},
		], async (node, dependencyResults) => {
			if (node.key === 'core') {
				coreRuns += 1;
			}
			if (node.key === 'a') {
				started.a = true;
				await waitFor(() => started.b, 'a and b did not run concurrently');
			}
			if (node.key === 'b') {
				started.b = true;
				await waitFor(() => started.a, 'a and b did not run concurrently');
			}
			if (node.key === 'app') {
				expect([...dependencyResults.keys()].sort()).toStrictEqual(['a', 'b']);
			}
			order.push(node.key);
			return `${node.key}-result`;
		});

		expect(coreRuns).toBe(1);
		expect(order[0]).toBe('core');
		expect(order.at(-1)).toBe('app');
		expect(results.get('app')).toBe('app-result');
		expect(results.size).toBe(4);
	});

	test('runs unrelated leaves concurrently', async () => {
		const started = new Set<string>();
		const results = await runDependencyGraph<string, string, string>([
			{
				key: 'x',
				value: 'x',
				dependencies: [],
			},
			{
				key: 'y',
				value: 'y',
				dependencies: [],
			},
			{
				key: 'z',
				value: 'z',
				dependencies: [],
			},
		], async (node) => {
			started.add(node.key);
			await waitFor(() => started.size === 3, 'leaves did not run concurrently');
			return node.key;
		});

		expect([...results.keys()].sort()).toStrictEqual(['x', 'y', 'z']);
	});

	test('associates results by key despite completion order', async () => {
		const results = await runDependencyGraph<string, number, string>([
			{
				key: 'slow',
				value: 30,
				dependencies: [],
			},
			{
				key: 'fast',
				value: 1,
				dependencies: [],
			},
			{
				key: 'medium',
				value: 10,
				dependencies: [],
			},
		], async (node) => {
			await setTimeout(node.value);
			return `${node.key}-done`;
		});

		expect(results.get('slow')).toBe('slow-done');
		expect(results.get('fast')).toBe('fast-done');
		expect(results.get('medium')).toBe('medium-done');
	});

	test('prevents dependents from running after a failure while independents settle', async () => {
		const ran: string[] = [];
		let slowDone = false;
		let message = '';
		try {
			await runDependencyGraph<string, string, string>([
				{
					key: 'failing',
					value: 'failing',
					dependencies: [],
				},
				{
					key: 'blocked',
					value: 'blocked',
					dependencies: ['failing'],
				},
				{
					key: 'slow',
					value: 'slow',
					dependencies: [],
				},
			], async (node) => {
				ran.push(node.key);
				if (node.key === 'failing') {
					throw new Error('boom');
				}
				if (node.key === 'slow') {
					await setTimeout(20);
					slowDone = true;
				}
				return node.key;
			});
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}

		expect(message).toBe('boom');
		expect(ran).not.toContain('blocked');
		await waitFor(() => slowDone, 'independent work did not settle after the failure');
		expect(ran).toContain('slow');
	});

	for (const [label, nodes, message] of [
		['duplicate keys', [
			{
				key: 'a',
				value: 'first',
				dependencies: [],
			},
			{
				key: 'a',
				value: 'second',
				dependencies: [],
			},
		], 'Duplicate graph node key'],
		['unknown dependencies', [
			{
				key: 'a',
				value: 'a',
				dependencies: ['ghost'],
			},
		], 'Unknown graph dependency'],
		['self cycles', [
			{
				key: 'a',
				value: 'a',
				dependencies: ['a'],
			},
		], 'Dependency cycle detected'],
		['multi-node cycles', [
			{
				key: 'a',
				value: 'a',
				dependencies: ['b'],
			},
			{
				key: 'b',
				value: 'b',
				dependencies: ['c'],
			},
			{
				key: 'c',
				value: 'c',
				dependencies: ['a'],
			},
		], 'Dependency cycle detected'],
	] as const) {
		test(`rejects ${label} before running callbacks`, async () => {
			const ran: string[] = [];
			let caught = '';
			try {
				await runDependencyGraph(nodes, async (node) => {
					ran.push(node.key);
					return node.key;
				});
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				caught = (error as Error).message;
			}
			expect(caught).toContain(message);
			expect(ran).toStrictEqual([]);
		});
	}
});
