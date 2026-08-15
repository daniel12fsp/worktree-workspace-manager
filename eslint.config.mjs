// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'webview/__tests__/**',
      'src/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.d.ts',
      'verify.js',
      'verify.config.json',
      '*.config.*',
      '*.mjs',
      '*.cjs',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.strict,
      ...tseslint.configs.stylistic,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      complexity: ['warn', 10],
      'max-depth': ['warn', 4],
      'max-lines': ['warn', 300],
      'max-nested-callbacks': ['warn', 4],
      'max-params': ['warn', 5],
      'no-return-assign': 'warn',
      'no-param-reassign': 'warn',
    },
  },
  {
    files: ['webview/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.strict,
      ...tseslint.configs.stylistic,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      complexity: ['warn', 10],
      'max-depth': ['warn', 4],
      'max-lines': ['warn', 300],
      'max-nested-callbacks': ['warn', 4],
      'max-params': ['warn', 5],
      'no-return-assign': 'warn',
      'no-param-reassign': 'warn',
    },
  },
]);