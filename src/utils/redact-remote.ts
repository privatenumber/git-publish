export const redactRemote = (value: string) => value.replace(
	/(\b(?:git\+)?[a-z][a-z\d+.-]*:\/\/)[^/\s@]*:[^/\s@]*@/gi,
	'$1[redacted]@',
);
