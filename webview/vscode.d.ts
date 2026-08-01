declare function acquireVsCodeApi(): {
  postMessage(message: Record<string, unknown>): void;
  getState(): unknown;
  setState(state: unknown): void;
};
