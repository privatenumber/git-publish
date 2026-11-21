import spawn from 'nano-spawn';

export const validatePublishBranch = async (branch: string) => {
	const hint = "Use a template such as --branch 'preview/{package}' or --branch 'preview/{gitSha}/{package}'.";
	if (!/^[\w./@-]+$/.test(branch)
		|| /^(?:refs|heads|tags|remotes)\//.test(branch)
		|| branch === '@'
		|| /^[A-Z_]+$/.test(branch)
		|| /^head$/i.test(branch)
		|| /^[a-f0-9]{7,64}$/i.test(branch)) {
		throw new Error(`Invalid publish branch ${JSON.stringify(branch)}. Use only ASCII letters, digits, and . _ / @ - with no refs/, heads/, tags/, or remotes/ prefix. Avoid bare @, HEAD in any case, names made only of uppercase letters and underscores, and bare names of 7 to 64 hexadecimal digits. ${hint}`);
	}
	try {
		await spawn('git', ['check-ref-format', '--branch', branch]);
	} catch {
		throw new Error(`Invalid publish branch ${JSON.stringify(branch)}. The name must also be a valid Git branch. ${hint}`);
	}
};

const placeholders = ['{gitRef}', '{gitSha}', '{package}'] as const;

const supportedPlaceholders = placeholders.join(', ');

export const renderPackageBranch = ({
	template,
	gitRef,
	gitSha,
	packageName,
}: {
	template: string;
	gitRef: string;
	gitSha: string;
	packageName: string;
}): string => {
	const values = {
		'{gitRef}': gitRef,
		'{gitSha}': gitSha,
		'{package}': packageName,
	};
	const rendered = template.replaceAll(/\{[^{}]*\}/g, (placeholder) => {
		if (!(placeholder in values)) {
			throw new Error(`Unknown branch template placeholder ${JSON.stringify(placeholder)}. Supported placeholders: ${supportedPlaceholders}.`);
		}
		return values[placeholder as keyof typeof values];
	});
	if (rendered.includes('{') || rendered.includes('}')) {
		throw new Error(`Invalid branch template ${JSON.stringify(template)}. Supported placeholders: ${supportedPlaceholders}.`);
	}
	return rendered;
};
