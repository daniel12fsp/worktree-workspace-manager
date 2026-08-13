import React from "react";
import { createRoot } from "react-dom/client";
import { VsCodeContext, type VsCodeApi } from "./hooks/useVsCode";
import { App, type AppState } from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// Store reference for link provider callbacks
(window as any).WorktreeTerminals = { vscodeApi: vscode };

// Report errors to extension host
window.onerror = (message, source, line, column, error) => {
  vscode.postMessage({
    type: "webviewError",
    message: String(message),
    source: source ? String(source) : undefined,
    line: line ? Number(line) : undefined,
    column: column ? Number(column) : undefined,
    stack: error && (error as Error).stack,
  });
};
window.onunhandledrejection = (event) => {
  const reason = event.reason;
  vscode.postMessage({
    type: "webviewError",
    message: reason && reason.message ? reason.message : String(reason),
    stack: reason && reason.stack,
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
