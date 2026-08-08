import { describe, it, expect, vi } from "vitest";
import {
  trimTerminalLink,
  parseFileLink,
  detectTerminalLinks,
  collectMatches,
  updateFocusClasses,
  stripTerminalQueryResponses,
  stripTerminalGeneratedInput,
  stripMouseReports,
  sanitizeReplayedTerminalOutput,
  TerminalControlSanitizer,
  TerminalInputSanitizer,
} from "../hooks/useTerminal";

describe("trimTerminalLink", () => {
  it("trims trailing punctuation", () => {
    expect(trimTerminalLink("file.txt,")).toEqual({ text: "file.txt" });
  });

  it("does not trim colon-number patterns", () => {
    expect(trimTerminalLink("file.txt:42")).toEqual({ text: "file.txt:42" });
  });

  it("preserves colon-number-colon-number", () => {
    expect(trimTerminalLink("file.txt:42:5")).toEqual({
      text: "file.txt:42:5",
    });
  });

  it("returns original when no trailing punctuation", () => {
    expect(trimTerminalLink("file.txt")).toEqual({ text: "file.txt" });
  });

  it("trims multiple trailing characters", () => {
    expect(trimTerminalLink("file.txt);")).toEqual({ text: "file.txt" });
  });

  it("handles empty string", () => {
    expect(trimTerminalLink("")).toEqual({ text: "" });
  });

  it("handles string with only punctuation", () => {
    expect(trimTerminalLink(".,;:")).toEqual({ text: "" });
  });
});

describe("parseFileLink", () => {
  it("parses path only", () => {
    const result = parseFileLink("src/file.ts");
    expect(result).toEqual({
      path: "src/file.ts",
      line: undefined,
      column: undefined,
    });
  });

  it("parses path with line", () => {
    const result = parseFileLink("src/file.ts:42");
    expect(result).toEqual({
      path: "src/file.ts",
      line: 42,
      column: undefined,
    });
  });

  it("parses path with line and column", () => {
    const result = parseFileLink("src/file.ts:42:5");
    expect(result).toEqual({ path: "src/file.ts", line: 42, column: 5 });
  });

  it("handles absolute path", () => {
    const result = parseFileLink("/tmp/file.ts:10");
    expect(result.path).toBe("/tmp/file.ts");
    expect(result.line).toBe(10);
  });

  it("handles path without line numbers", () => {
    const result = parseFileLink("README.md");
    expect(result.path).toBe("README.md");
    expect(result.line).toBeUndefined();
    expect(result.column).toBeUndefined();
  });

  it("handles Windows-style path", () => {
    const result = parseFileLink("C:\\Users\\file.ts:10");
    expect(result.path).toBe("C:\\Users\\file.ts");
    expect(result.line).toBe(10);
  });
});

describe("collectMatches", () => {
  it("collects URL matches", () => {
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [];
    collectMatches(
      "visit https://example.com for info",
      /\bhttps?:\/\/[^\s<>"'`]+/g,
      "url",
      links,
      occupied,
      1,
    );
    expect(links.length).toBe(1);
    expect(links[0].text).toContain("https://example.com");
  });

  it("does not overlap with occupied ranges", () => {
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [
      { start: 0, end: 30 },
    ];
    collectMatches(
      "https://example.com",
      /\bhttps?:\/\/[^\s<>"'`]+/g,
      "url",
      links,
      occupied,
      1,
    );
    expect(links.length).toBe(0);
  });

  it("collects file matches", () => {
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [];
    collectMatches(
      "see src/file.ts for details",
      /(?:~|\.{1,2}|\/|[A-Za-z]:[\\/]|[A-Za-z0-9_.-]+\/)[^\s<>"'`]+/g,
      "file",
      links,
      occupied,
      1,
    );
    expect(links.length).toBeGreaterThan(0);
  });

  it("handles empty text", () => {
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [];
    collectMatches("", /\bhttps?:\/\/[^\s<>"'`]+/g, "url", links, occupied, 1);
    expect(links.length).toBe(0);
  });

  it("handles text with no matches", () => {
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [];
    collectMatches(
      "no links here",
      /\bhttps?:\/\/[^\s<>"'`]+/g,
      "url",
      links,
      occupied,
      1,
    );
    expect(links.length).toBe(0);
  });
});

describe("detectTerminalLinks", () => {
  it("detects URLs in text", () => {
    const links = detectTerminalLinks("visit https://example.com now", 1);
    expect(links).toBeTruthy();
    expect(links!.length).toBeGreaterThan(0);
  });

  it("returns undefined for no matches", () => {
    const links = detectTerminalLinks("no links here", 1);
    expect(links).toBeUndefined();
  });

  it("detects file paths", () => {
    const links = detectTerminalLinks("see src/index.ts for details", 1);
    expect(links).toBeTruthy();
  });

  it("detects multiple URLs", () => {
    const links = detectTerminalLinks(
      "visit https://a.com and https://b.com",
      1,
    );
    expect(links).toBeTruthy();
    expect(links!.length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty text", () => {
    const links = detectTerminalLinks("", 1);
    expect(links).toBeUndefined();
  });
});

describe("stripTerminalQueryResponses", () => {
  it("removes terminal capability and color query responses", () => {
    const input =
      "\x1b[?0;276;0c\x1b[>0;276;0c\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\";
    expect(stripTerminalQueryResponses(input)).toBe("");
  });

  it("preserves normal input around query responses", () => {
    expect(
      stripTerminalQueryResponses("echo hi\x1b[?0;276;0c\x1b[>0;276;0c\r"),
    ).toBe("echo hi\r");
  });

  it("removes additional terminal-generated replies", () => {
    const input = "a\x1b[12;34R\x1b[8;24;80t\x1b[?2004;1$yb";
    expect(stripTerminalQueryResponses(input)).toBe("ab");
  });

  it("removes 8-bit C1 query responses", () => {
    expect(stripTerminalQueryResponses("a\x9b>0;276;0cb")).toBe("ab");
  });
});

describe("stripTerminalGeneratedInput", () => {
  it("covers Repro A by removing leaked device attribute responses", () => {
    expect(stripTerminalGeneratedInput("\x1b[>0;276;0c", "idle")).toBe("");
    expect(stripTerminalGeneratedInput("echo hi\x1b[>0;276;0c\r", "idle")).toBe(
      "echo hi\r",
    );
  });

  it("removes mouse reports while the active session is idle", () => {
    const input = "a\x1b[<35;10;5M\x1b[<35;11;5mb";
    expect(stripTerminalGeneratedInput(input, "idle")).toBe("ab");
  });

  it("preserves mouse reports while the active session is running", () => {
    const input = "a\x1b[<35;10;5Mb";
    expect(stripTerminalGeneratedInput(input, "running")).toBe(input);
  });

  it("removes x10 mouse reports while idle", () => {
    expect(stripMouseReports("a\x1b[M !!b")).toBe("ab");
  });

  it("handles leaked DA2 split across chunks", () => {
    const sanitizer = new TerminalInputSanitizer();
    const output = [
      sanitizer.write("A\x1b", "idle"),
      sanitizer.write("[>", "idle"),
      sanitizer.write("0;276;", "idle"),
      sanitizer.write("0cB", "idle"),
    ].join("");
    expect(output).toBe("AB");
  });

  it("preserves keyboard input sequences while idle", () => {
    expect(stripTerminalGeneratedInput("a\x1b[Ab", "idle")).toBe("a\x1b[Ab");
  });
});

describe("sanitizeReplayedTerminalOutput", () => {
  it("removes replayed terminal queries that can generate input", () => {
    const input = "a\x1b[c\x1b[>c\x1b[0c\x1b[>0c\x1b[6nb";
    expect(sanitizeReplayedTerminalOutput(input)).toBe("ab");
  });

  it("covers Repro B by removing replayed stale mouse tracking enables", () => {
    const input = "a\x1b[?1003h\x1b[?1006h\x1b[?1000;1002;1006hb";
    expect(sanitizeReplayedTerminalOutput(input)).toBe("ab");
  });

  it("preserves normal text, colors, and non-input terminal modes", () => {
    const input = "\x1b[31mred\x1b[0m\x1b[?25h";
    expect(sanitizeReplayedTerminalOutput(input)).toBe(input);
  });

  it("removes replayed terminal size and DEC mode queries", () => {
    const input = "a\x1b[18t\x1b[?2004$pb";
    expect(sanitizeReplayedTerminalOutput(input)).toBe("ab");
  });
});

const stripEveryTerminalSequence = (sequence: string) =>
  sequence.startsWith("\x1b") ||
  sequence.startsWith("\x90") ||
  sequence.startsWith("\x9d") ||
  sequence.startsWith("\x9e") ||
  sequence.startsWith("\x9f");

describe("TerminalControlSanitizer fixture corpus", () => {
  const cases: Array<[string, string, string]> = [
    ["SGR", "A\x1b[38;2;12;34;56mB", "AB"],
    ["OSC BEL", "A\x1b]2;title\x07B", "AB"],
    ["OSC ST", "A\x1b]7;file://localhost/tmp\x1b\\B", "AB"],
    ["DCS", "A\x1bP1$r0m\x1b\\B", "AB"],
    ["APC", "A\x1b_payload\x1b\\B", "AB"],
    ["PM", "A\x1b^payload\x1b\\B", "AB"],
    ["SOS", "A\x1bXpayload\x1b\\B", "AB"],
    ["8-bit OSC", "A\x9d2;title\x9cB", "AB"],
  ];

  it.each(cases)("strips %s", (_name, input, expected) => {
    const sanitizer = new TerminalControlSanitizer(stripEveryTerminalSequence);
    expect(sanitizer.write(input)).toBe(expected);
  });

  it("is stateful across OSC chunk boundaries", () => {
    const sanitizer = new TerminalControlSanitizer(stripEveryTerminalSequence);
    const output = [
      sanitizer.write("A\x1b]"),
      sanitizer.write("2;long-title"),
      sanitizer.write("\x1b"),
      sanitizer.write("\\B"),
    ].join("");
    expect(output).toBe("AB");
  });
});

describe("updateFocusClasses", () => {
  it("toggles focused class on element", () => {
    document.body.innerHTML = '<div class="terminalInline"></div>';
    updateFocusClasses(true);
    const el = document.querySelector(".terminalInline");
    expect(el?.classList.contains("focused")).toBe(true);
    expect(el?.classList.contains("lostFocus")).toBe(false);
  });

  it("toggles lostFocus class", () => {
    document.body.innerHTML = '<div class="terminalInline"></div>';
    updateFocusClasses(false);
    const el = document.querySelector(".terminalInline");
    expect(el?.classList.contains("focused")).toBe(false);
    expect(el?.classList.contains("lostFocus")).toBe(true);
  });

  it("does nothing when no element found", () => {
    document.body.innerHTML = "";
    expect(() => updateFocusClasses(true)).not.toThrow();
  });
});

describe("collectMatches activate/hover", () => {
  it("activate posts openExternalLink for URL", () => {
    const mockPostMessage = vi.fn();
    (window as any).WorktreeTerminals = {
      vscodeApi: { postMessage: mockPostMessage },
    };
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [];
    collectMatches(
      "visit https://example.com for info",
      /\bhttps?:\/\/[^\s<>"'`]+/g,
      "url",
      links,
      occupied,
      1,
    );
    expect(links.length).toBe(1);
    links[0].activate();
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "openExternalLink",
      href: "https://example.com",
    });
    delete (window as any).WorktreeTerminals;
  });

  it("activate posts openTerminalFileLink for file", () => {
    const mockPostMessage = vi.fn();
    (window as any).WorktreeTerminals = {
      vscodeApi: { postMessage: mockPostMessage },
    };
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [];
    collectMatches(
      "see src/file.ts for details",
      /(?:~|\.{1,2}|\/|[A-Za-z]:[\\/]|[A-Za-z0-9_.-]+\/)[^\s<>"'`]+/g,
      "file",
      links,
      occupied,
      1,
    );
    expect(links.length).toBeGreaterThan(0);
    links[0].activate();
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openTerminalFileLink" }),
    );
    delete (window as any).WorktreeTerminals;
  });

  it("hover sets title on target", () => {
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [];
    collectMatches(
      "visit https://example.com",
      /\bhttps?:\/\/[^\s<>"'`]+/g,
      "url",
      links,
      occupied,
      1,
    );
    expect(links.length).toBe(1);
    const target = { title: "" };
    links[0].hover({ target });
    expect(target.title).toBe("Open link");
  });

  it("hover sets file title for file links", () => {
    const links: any[] = [];
    const occupied: Array<{ start: number; end: number }> = [];
    collectMatches(
      "see src/file.ts",
      /(?:~|\.{1,2}|\/|[A-Za-z]:[\\/]|[A-Za-z0-9_.-]+\/)[^\s<>"'`]+/g,
      "file",
      links,
      occupied,
      1,
    );
    expect(links.length).toBeGreaterThan(0);
    const target = { title: "" };
    links[0].hover({ target });
    expect(target.title).toBe("Open file");
  });
});

describe("trimTerminalLink edge cases", () => {
  it("does not trim after colon-number pattern", () => {
    expect(trimTerminalLink("file.txt:42:5")).toEqual({
      text: "file.txt:42:5",
    });
  });

  it("trims trailing punctuation after colon-number", () => {
    expect(trimTerminalLink("file.txt:42),")).toEqual({ text: "file.txt:42" });
  });
});

describe("detectTerminalLinks overlapping", () => {
  it("does not create overlapping links", () => {
    const links = detectTerminalLinks("https://example.com and src/file.ts", 1);
    expect(links).toBeTruthy();
    // Should have 2 links, no overlap
    if (links) {
      for (let i = 0; i < links.length; i++) {
        for (let j = i + 1; j < links.length; j++) {
          const a = links[i].range;
          const b = links[j].range;
          const noOverlap =
            a.end.x <= b.start.x ||
            b.end.x <= a.start.x ||
            a.end.y !== b.start.y;
          expect(noOverlap).toBe(true);
        }
      }
    }
  });
});
