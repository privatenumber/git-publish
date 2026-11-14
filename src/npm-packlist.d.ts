declare module 'npm-packlist' {
	const packlist: (tree: {
		path: string;
		package: Record<string, unknown>;
		isProjectRoot: boolean;
		edgesOut: Map<string, unknown>;
	}) => Promise<string[]>;
	export default packlist;
}
