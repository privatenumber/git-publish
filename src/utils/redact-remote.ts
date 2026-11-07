export const redactRemote = (value: string) => value
	.replaceAll(/(\b(?:git\+)?(?:https?|git):\/\/)[^\s/@]+@/gi, '$1[redacted]@')
	.replaceAll(/(\b(?:git\+)?[a-z][a-z\d+.-]*:\/\/)[^\s/:@]*:[^\s/@]*@/gi, '$1[redacted]@');
