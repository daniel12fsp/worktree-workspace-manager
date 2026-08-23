import type {
  TerminalWriteOperation,
  WebviewTerminalSession,
} from "./terminalTypes";

const SNAPSHOT_OUTPUT_INTERVAL = 100_000;

export function snapshotTerminalSession(
  session: WebviewTerminalSession,
  onSnapshot: (id: string, data: string, outputOffset: number) => void,
  force = false,
): void {
  if (
    session.writing ||
    !session.snapshotDirty ||
    (!force &&
      session.outputOffset - session.lastSnapshotOffset <
        SNAPSHOT_OUTPUT_INTERVAL)
  ) {
    return;
  }
  try {
    const data = session.serializeAddon.serialize();
    onSnapshot(session.id, data, session.outputOffset);
    session.lastSnapshotOffset = session.outputOffset;
    session.snapshotDirty = false;
  } catch (error) {
    console.error("Failed to serialize terminal:", error);
  }
}

export function enqueueTerminalWrite(
  session: WebviewTerminalSession,
  operation: TerminalWriteOperation,
  onWriteComplete: (forceSnapshot: boolean) => void,
): void {
  session.writes.push(operation);
  drainWrites(session, onWriteComplete);
}

function drainWrites(
  session: WebviewTerminalSession,
  onWriteComplete: (forceSnapshot: boolean) => void,
): void {
  if (session.writing) return;
  const operation = session.writes.shift();
  if (!operation) return;

  session.writing = true;
  if (operation.kind === "restore") {
    session.forwardingInput = false;
  }

  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    session.outputOffset = operation.outputOffset;
    session.snapshotDirty = true;
    if (operation.kind === "restore") session.forwardingInput = true;
    session.writing = false;
    operation.onComplete?.();
    onWriteComplete(operation.kind === "restore");
    drainWrites(session, onWriteComplete);
  };

  try {
    if (operation.kind === "restore") session.term.reset();
    if (!operation.data) complete();
    else session.term.write(operation.data, complete);
  } catch (error) {
    console.error("Failed to write terminal data:", error);
    complete();
  }
}
