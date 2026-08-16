let seq = 0;

export function webviewProfileMark(
  enabled: boolean | undefined,
  name: string,
): void {
  if (!enabled) return;
  performance.mark(`wtwm.webview:${name}`);
}

export function webviewProfileMeasure<T>(
  enabled: boolean | undefined,
  name: string,
  fn: () => T,
  data?: Record<string, unknown>,
): T {
  if (!enabled) return fn();

  const id = ++seq;
  const start = `wtwm.webview:${name}:start:${String(id)}`;
  const end = `wtwm.webview:${name}:end:${String(id)}`;
  performance.mark(start);
  try {
    return fn();
  } finally {
    performance.mark(end);
    const measure = performance.measure(`wtwm.webview:${name}`, start, end);
    console.debug("[Terminals by Worktree] profile measure", {
      name: measure.name,
      durationMs: Number(measure.duration.toFixed(2)),
      ...data,
    });
    performance.clearMarks(start);
    performance.clearMarks(end);
    performance.clearMeasures(measure.name);
  }
}
