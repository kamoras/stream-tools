// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'data/'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },
  {
    files: ['src/server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/client/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: {
      // protocol.ts depends on zod; the browser may only import its types.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/shared/protocol.js'],
              allowTypeImports: true,
              message: 'Import runtime constants from shared/endpoints.js instead.',
            },
            {
              group: ['**/server/**', 'zod'],
              message: 'Browser code must not import server modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // `expect(() => fn()).toThrow()` is idiomatic in tests.
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
