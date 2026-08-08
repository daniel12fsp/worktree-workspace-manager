import { describe, expect, it } from "vitest";
import {
  TerminalControlSanitizer,
  sanitizeTerminalStream,
  stripEveryTerminalSequence,
  stripTerminalControlSequences,
} from "../terminalControl";

describe("terminalControl", () => {
  it("strips common terminal control sequences", () => {
    const input = [
      "A\x1b[31mB\x1b[0m",
      "C\x1b]2;title\x07D",
      "E\x1bP1$r0m\x1b\\F",
      "G\x1b^payload\x1b\\H",
      "I\x1bXpayload\x1b\\J",
      "K\x9d2;title\x9cL",
    ].join("");

    expect(stripTerminalControlSequences(input)).toBe("ABCDEFGHIJKL");
  });

  it("preserves sequences when predicate returns false", () => {
    const input = "A\x1b[31mB";
    expect(sanitizeTerminalStream(input, () => false)).toEqual({
      output: input,
      pending: "",
    });
  });

  it("keeps incomplete sequences pending across writes", () => {
    const sanitizer = new TerminalControlSanitizer(stripEveryTerminalSequence);
    const output = [
      sanitizer.write("A\x1b]"),
      sanitizer.write("2;title"),
      sanitizer.write("\x1b"),
      sanitizer.write("\\B"),
    ].join("");

    expect(output).toBe("AB");
    expect(sanitizer.flush()).toBe("");
  });

  it("flushes incomplete pending data", () => {
    const sanitizer = new TerminalControlSanitizer(stripEveryTerminalSequence);

    expect(sanitizer.write("A\x1b]")).toBe("A");
    expect(sanitizer.flush()).toBe("\x1b]");
  });

  it("handles charset designation, single escape, c1 csi, and mouse csi", () => {
    const input = "A\x1b(B\x1b7B\x9b31mC\x1b[MxyzD";

    expect(stripTerminalControlSequences(input)).toBe("ABCD");
  });
});
