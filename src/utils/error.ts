export const getErrorDetails = (error: unknown): string => {
	if (error instanceof AggregateError) {
		return error.errors.map(nested => (nested instanceof Error ? nested.message : String(nested))).join('\n');
	}

	return error instanceof Error ? error.message : String(error);
};
