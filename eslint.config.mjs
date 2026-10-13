import js from '@eslint/js';
import globals from 'globals';

export default [
	{
		ignores: ['dist/**', 'node_modules/**', 'server/src/**', 'docs/.vitepress/**'],
	},
	js.configs.recommended,
	{
		files: ['**/*.js', '**/*.jsx'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'commonjs',
			globals: { ...globals.node, strapi: 'readonly' },
		},
	},
	{
		files: ['scripts/**/*.mjs'],
		languageOptions: {
			sourceType: 'module',
			globals: globals.node,
		},
	},
	{
		files: ['admin/src/**/*.js', 'admin/src/**/*.jsx'],
		languageOptions: {
			sourceType: 'module',
			globals: globals.browser,
			parserOptions: { ecmaFeatures: { jsx: true } },
		},
	},
];
