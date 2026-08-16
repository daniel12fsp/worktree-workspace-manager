import React from "react";
import { createRoot } from "react-dom/client";
import { VsCodeContext, type VsCodeApi } from "./hooks/useVsCode";
import { App, type AppState } from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
  interface Window {
    WorktreeTerminals: { vscodeApi: VsCodeApi };
  }
}

const vscode = acquireVsCodeApi();

// Store reference for link provider callbacks
window.WorktreeTerminals = { vscodeApi: vscode };

// Report errors to extension host
window.onerror = (message, source, line, column, error) => {
  vscode.postMessage({
    type: "webviewError",
    message,
    source: source ?? undefined,
    line: line ?? undefined,
    column: column ?? undefined,
    stack: error?.stack,
  });
};
window.onunhandledrejection = (event) => {
  const reason: unknown = event.reason;
  const error = reason instanceof Error ? reason : undefined;
  vscode.postMessage({
    type: "webviewError",
    message: error?.message ?? String(reason),
    stack: error?.stack,
  });
};

// Initial state from static HTML or default
const initialState: AppState = {
  repos: [],
  activeSessionId: undefined,
  activeOutput: "",
  hasWorkspace: true,
  home: "",
  loadingWorktrees: new Set(),
  terminalsLayoutOrder: "terminalFirst",
  webviewRenderTelemetry: "off",
};

// Mount React
const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(
    <VsCodeContext.Provider value={vscode}>
      <App initialState={initialState} />
    </VsCodeContext.Provider>,
  );
}

// Notify extension host that webview is ready
vscode.postMessage({ type: "ready" });
