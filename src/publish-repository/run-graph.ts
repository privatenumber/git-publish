export type GraphNode<Key, Value> = {
	key: Key;
	value: Value;
	dependencies: readonly Key[];
};

export const runDependencyGraph = async <Key, Value, Result>(
	nodes: readonly GraphNode<Key, Value>[],
	run: (
		node: GraphNode<Key, Value>,
		dependencyResults: ReadonlyMap<Key, Result>,
	) => Promise<Result>,
): Promise<ReadonlyMap<Key, Result>> => {
	const byKey = new Map<Key, GraphNode<Key, Value>>();
	for (const node of nodes) {
		if (byKey.has(node.key)) {
			throw new Error(`Duplicate graph node key ${JSON.stringify(node.key)}.`);
		}
		byKey.set(node.key, node);
	}
	for (const node of nodes) {
		for (const dependency of node.dependencies) {
			if (!byKey.has(dependency)) {
				throw new Error(`Unknown graph dependency ${JSON.stringify(dependency)} required by ${JSON.stringify(node.key)}.`);
			}
		}
	}

	const visited = new Set<Key>();
	const visiting: Key[] = [];
	const checkCycles = (node: GraphNode<Key, Value>): void => {
		if (visited.has(node.key)) {
			return;
		}
		const cycleStart = visiting.indexOf(node.key);
		if (cycleStart !== -1) {
			const cycle = [...visiting.slice(cycleStart), node.key].map(String);
			throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}.`);
		}
		visiting.push(node.key);
		for (const dependency of node.dependencies) {
			checkCycles(byKey.get(dependency)!);
		}
		visiting.pop();
		visited.add(node.key);
	};
	for (const node of nodes) {
		checkCycles(node);
	}

	const results = new Map<Key, Result>();
	const pending = new Map<Key, Promise<Result>>();
	const runNode = (key: Key): Promise<Result> => {
		const existing = pending.get(key);
		if (existing) {
			return existing;
		}
		const task = (async () => {
			const node = byKey.get(key)!;
			const dependencyResults = new Map<Key, Result>();
			for (const dependency of node.dependencies) {
				dependencyResults.set(dependency, await runNode(dependency));
			}
			const result = await run(node, dependencyResults);
			results.set(key, result);
			return result;
		})();
		pending.set(key, task);
		return task;
	};
	await Promise.all(nodes.map(node => runNode(node.key)));
	return results;
};
