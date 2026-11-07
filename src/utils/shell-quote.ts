export const shellQuote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`;
