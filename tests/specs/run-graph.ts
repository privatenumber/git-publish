import { describe, test, expect } from 'manten';
import {
	runDependencyGraph, type GraphNode,
} from '../../src/workspace-publication/run-graph.ts';

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
		const aStarted = Promise.withResolvers<void>();
		const bStarted = Promise.withResolvers<void>();
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
				aStarted.resolve();
				await bStarted.promise;
			}
			if (node.key === 'b') {
				bStarted.resolve();
				await aStarted.promise;
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
		const allStarted = Promise.withResolvers<void>();
		let started = 0;
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
			started += 1;
			if (started === 3) {
				allStarted.resolve();
			}
			await allStarted.promise;
			return node.key;
		});

		expect([...results.keys()].sort()).toStrictEqual(['x', 'y', 'z']);
	});

	test('associates results by key despite completion order', async () => {
		const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
		for (const key of ['slow', 'fast', 'medium']) {
			gates.set(key, Promise.withResolvers<void>());
		}
		const graphPromise = runDependencyGraph<string, string, string>([
			{
				key: 'slow',
				value: 'slow',
				dependencies: [],
			},
			{
				key: 'fast',
				value: 'fast',
				dependencies: [],
			},
			{
				key: 'medium',
				value: 'medium',
				dependencies: [],
			},
		], async (node) => {
			await gates.get(node.key)!.promise;
			return `${node.key}-done`;
		});
		gates.get('medium')!.resolve();
		gates.get('fast')!.resolve();
		gates.get('slow')!.resolve();
		const results = await graphPromise;

		expect(results.get('slow')).toBe('slow-done');
		expect(results.get('fast')).toBe('fast-done');
		expect(results.get('medium')).toBe('medium-done');
	});

	test('prevents dependents from running after a failure while independents settle', async () => {
		const slowStarted = Promise.withResolvers<void>();
		const releaseSlow = Promise.withResolvers<void>();
		const failureObserved = Promise.withResolvers<void>();
		const ran: string[] = [];
		let slowFinished = false;
		let graphSettled = false;
		const graphPromise = runDependencyGraph<string, string, string>([
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
			if (node.key === 'slow') {
				slowStarted.resolve();
				await releaseSlow.promise;
				slowFinished = true;
				return node.key;
			}
			if (node.key === 'failing') {
				await slowStarted.promise;
				failureObserved.resolve();
				throw new Error('boom');
			}
			return node.key;
		}).finally(() => {
			graphSettled = true;
		});

		await failureObserved.promise;
		expect(graphSettled).toBe(false);

		releaseSlow.resolve();

		let message = '';
		try {
			await graphPromise;
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toBe('boom');
		expect(ran).not.toContain('blocked');
		expect(slowFinished).toBe(true);
		expect(graphSettled).toBe(true);
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
