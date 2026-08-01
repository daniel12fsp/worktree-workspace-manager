export class SearchAddon {
  findNext(_query: string, _options?: any) {}
  findPrevious(_query: string, _options?: any) {}
  clearDecorations() {}
  onDidChangeResults(_callback: (event: any) => void) {
    return { dispose: () => {} };
  }
  dispose() {}
}
