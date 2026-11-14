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
