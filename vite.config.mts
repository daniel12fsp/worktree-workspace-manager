import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "media", "dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, "webview", "index.tsx"),
      output: {
        entryFileNames: "index.js",
        assetFileNames: "index.[ext]",
        format: "iife",
        name: "WorktreeTerminals",
      },
    },
    target: "es2022",
    minify: "esbuild",
  },
});
