export type TerminalSequence = {
  readonly value: string;
  readonly end: number;
  readonly complete: boolean;
};

export class TerminalControlSanitizer {
  private pending = "";

  constructor(private readonly shouldStrip: (sequence: string) => boolean) {}

  write(data: string): string {
    const result = sanitizeTerminalStream(
      this.pending + data,
      this.shouldStrip,
    );
    this.pending = result.pending;
    return result.output;
  }

  flush(): string {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }
}

export function sanitizeTerminalStream(
  data: string,
  shouldStrip: (sequence: string) => boolean,
): { output: string; pending: string } {
  let output = "";
  let index = 0;

  while (index < data.length) {
    const sequence = readTerminalSequence(data, index);
    if (!sequence) {
      output += data[index];
      index += 1;
      continue;
    }
    if (!sequence.complete) {
      return { output, pending: data.slice(index) };
    }
    if (!shouldStrip(sequence.value)) output += sequence.value;
    index = sequence.end;
  }

  return { output, pending: "" };
}

export function stripEveryTerminalSequence(sequence: string): boolean {
  return (
    sequence.startsWith("\x1b") ||
    sequence.startsWith("\x90") ||
    sequence.startsWith("\x9b") ||
    sequence.startsWith("\x9d") ||
    sequence.startsWith("\x9e") ||
    sequence.startsWith("\x9f")
  );
}

export function stripTerminalControlSequences(data: string): string {
  const sanitizer = new TerminalControlSanitizer(stripEveryTerminalSequence);
  return sanitizer.write(data);
}

function readTerminalSequence(
  data: string,
  start: number,
): TerminalSequence | undefined {
  const code = data.charCodeAt(start);
  if (code === 0x1b) return readEscSequence(data, start);
  if (code === 0x9b) return readCsiSequence(data, start, start + 1);
  if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
    return readStringControl(data, start, start + 1, true);
  }
  return undefined;
}

function readEscSequence(data: string, start: number): TerminalSequence {
  if (start + 1 >= data.length) {
    return { value: data.slice(start), end: data.length, complete: false };
  }

  const next = data[start + 1];
  if (next === "[") return readCsiSequence(data, start, start + 2);
  if (
    next === "]" ||
    next === "P" ||
    next === "_" ||
    next === "^" ||
    next === "X"
  ) {
    return readStringControl(data, start, start + 2, false);
  }
  if (
    next === "(" ||
    next === ")" ||
    next === "*" ||
    next === "+" ||
    next === "-" ||
    next === "." ||
    next === "/"
  ) {
    const end = start + 3;
    return {
      value: data.slice(start, Math.min(end, data.length)),
      end: Math.min(end, data.length),
      complete: end <= data.length,
    };
  }

  return {
    value: data.slice(start, start + 2),
    end: start + 2,
    complete: true,
  };
}

function readCsiSequence(
  data: string,
  start: number,
  index: number,
): TerminalSequence {
  while (index < data.length) {
    const code = data.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      const end =
        code === 0x4d && data.slice(start, index + 1) === "\x1b[M"
          ? index + 4
          : index + 1;
      return {
        value: data.slice(start, Math.min(end, data.length)),
        end: Math.min(end, data.length),
        complete: end <= data.length,
      };
    }
    index += 1;
  }
  return { value: data.slice(start), end: data.length, complete: false };
}

function readStringControl(
  data: string,
  start: number,
  index: number,
  allowC1Terminator: boolean,
): TerminalSequence {
  while (index < data.length) {
    const code = data.charCodeAt(index);
    if (code === 0x07 || (allowC1Terminator && code === 0x9c)) {
      return {
        value: data.slice(start, index + 1),
        end: index + 1,
        complete: true,
      };
    }
    if (code === 0x1b && data[index + 1] === "\\") {
      return {
        value: data.slice(start, index + 2),
        end: index + 2,
        complete: true,
      };
    }
    index += 1;
  }
  return { value: data.slice(start), end: data.length, complete: false };
}
