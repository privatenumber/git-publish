import { describe, expect, test } from 'manten';
import { renderPackageBranch } from '../../src/package-publication/branch.ts';

describe('Branch templates', () => {
	for (const {
		title,
		template,
		expected,
	} of [
			{
				title: 'replaces {gitRef}',
				template: 'preview/{gitRef}',
				expected: 'preview/feature/auth',
			},
			{
				title: 'replaces {gitSha}',
				template: 'preview/{gitSha}',
				expected: 'preview/0123456789abcdef0123456789abcdef01234567',
			},
			{
				title: 'replaces every occurrence of a placeholder',
				template: 'preview/{package}/{package}',
				expected: 'preview/@test/adapter/@test/adapter',
			},
		]) {
		test(title, () => {
			expect(renderPackageBranch({
				template,
				gitRef: 'feature/auth',
				gitSha: '0123456789abcdef0123456789abcdef01234567',
				packageName: '@test/adapter',
			})).toBe(expected);
		});
	}

	test('rejects unknown placeholders', () => {
		expect(() => renderPackageBranch({
			template: 'preview/{version}',
			gitRef: 'feature/auth',
			gitSha: '0123456789abcdef0123456789abcdef01234567',
			packageName: '@test/adapter',
		})).toThrow('Unknown branch template placeholder "{version}". Supported placeholders: {gitRef}, {gitSha}, {package}.');
	});

	test('rejects {gitSha} without a source commit', () => {
		expect(() => renderPackageBranch({
			template: 'preview/{gitSha}',
			gitRef: 'main',
			gitSha: undefined,
			packageName: 'test-package',
		})).toThrow('Branch template "preview/{gitSha}" uses {gitSha}, but the source repository has no commit.');
	});
});
