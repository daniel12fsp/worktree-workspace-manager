export class SearchAddon {
  findNext(): void {
    return;
  }
  findPrevious(): void {
    return;
  }
  clearDecorations(): void {
    return;
  }
  onDidChangeResults(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  dispose(): void {
    return;
  }
}
