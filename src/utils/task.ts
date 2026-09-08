import { createTasuku, inline } from 'tasuku/create';

export default createTasuku({
	renderer: inline,
	outputStream: process.stdout,
});
