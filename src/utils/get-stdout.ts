export const getStdout = async (
	subprocess: Promise<{ stdout: string }>,
) => {
	const { stdout } = await subprocess;
	return stdout.trim();
};
