// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "out/**",
      "dist/**",
      "node_modules/**",
      "webview/__tests__/**",
      "src/__tests__/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.d.ts",
      "verify.js",
      "verify.config.json",
      "*.config.*",
      "*.mjs",
      "*.cjs",
    ],
  },
  {
    files: ["src/**/*.ts"],
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
      complexity: ["error", 10],
      "max-depth": ["error", 4],
      "max-lines": ["error", 300],
      "max-nested-callbacks": ["error", 4],
      "max-params": ["error", 5],
      "no-return-assign": "error",
      "no-param-reassign": "error",
    },
  },
  {
    files: ["webview/**/*.{ts,tsx}"],
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
      complexity: ["error", 10],
      "max-depth": ["error", 4],
      "max-lines": ["error", 300],
      "max-nested-callbacks": ["error", 4],
      "max-params": ["error", 5],
      "no-return-assign": "error",
      "no-param-reassign": "error",
    },
  },
]);
