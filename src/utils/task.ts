import { createTasuku, inline } from 'tasuku/create';
import { theme } from 'tasuku';

export default createTasuku({
	theme,
	renderer: inline,
	outputStream: process.stdout,
});
