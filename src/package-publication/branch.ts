const placeholders = ['[gitRef]', '[gitSha]', '[package]'] as const;

const supportedPlaceholders = placeholders.join(', ');

export const renderPackageBranch = ({
	template,
	gitRef,
	gitSha,
	packageName,
}: {
	template: string;
	gitRef: string;
	gitSha: string | undefined;
	packageName: string;
}): string => {
	const values = {
		'[gitRef]': gitRef,
		'[gitSha]': gitSha,
		'[package]': packageName,
	};
	const rendered = template.replaceAll(/\[[^[\]]*\]/g, (placeholder) => {
		if (!(placeholder in values)) {
			throw new Error(`Unknown branch template placeholder ${JSON.stringify(placeholder)}. Supported placeholders: ${supportedPlaceholders}.`);
		}
		if (placeholder === '[gitSha]' && !gitSha) {
			throw new Error(`Branch template ${JSON.stringify(template)} uses [gitSha], but the source repository has no commit.`);
		}
		return values[placeholder as keyof typeof values]!;
	});
	if (rendered.includes('[') || rendered.includes(']')) {
		throw new Error(`Invalid branch template ${JSON.stringify(template)}. Supported placeholders: ${supportedPlaceholders}.`);
	}
	return rendered;
};
