import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "webview/**/*.test.{ts,tsx}"],
    environmentMatchGlobs: [
      ["src/**", "node"],
      ["webview/**", "jsdom"],
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "webview/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.ts",
        "webview/**/*.test.{ts,tsx}",
        "src/__mocks__/**",
        "webview/__mocks__/**",
        "src/extension.ts",
        "src/workspaceFile.ts",
        "webview/index.tsx",
        "webview/vscode.d.ts",
        "webview/types.ts",
      ],
      thresholds: {
        lines: 90,
      },
    },
    setupFiles: ["./test-setup.ts"],
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/__mocks__/vscode.ts"),
      "@xterm/xterm": path.resolve(__dirname, "src/__mocks__/xterm.ts"),
      "@xterm/addon-search": path.resolve(
        __dirname,
        "src/__mocks__/xterm-search.ts",
      ),
      "@xterm/addon-fit": path.resolve(__dirname, "src/__mocks__/xterm-fit.ts"),
    },
  },
});
