export function createRefreshCoordinator(
  task: () => Promise<void>,
): () => Promise<void> {
  let requested = false;
  let running: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    while (requested) {
      requested = false;
      await task();
    }
  };

  return () => {
    requested = true;
    if (!running) {
      running = drain();
      const current = running;
      const reset = () => {
        if (running === current) running = undefined;
      };
      void current.then(reset, reset);
    }
    return running;
  };
}
