declare module '@npmcli/map-workspaces' {
	const mapWorkspaces: (options: { cwd: string;
		pkg: Record<string, unknown>; }) => Promise<Map<string, string>>;
	export default mapWorkspaces;
}
