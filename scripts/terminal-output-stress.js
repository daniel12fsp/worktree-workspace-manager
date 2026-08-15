#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");

const DEFAULTS = {
  lines: 100_000,
  chunkBytes: 8_192,
  delayMs: 0,
  label: "terminal-stress",
  stderrEvery: 0,
  exitCode: 0,
  profile: "normal",
  workers: 1,
  workerLabelPrefix: "terminal-stress",
  forever: false,
};

const PROFILES = new Set([
  "normal",
  "burst",
  "unicode",
  "long-lines",
  "ansi",
  "progress",
  "mixed",
]);

function usage() {
  return `Terminal output stress generator

Usage:
  node scripts/terminal-output-stress.js [options]

Options:
  --lines <n>                  Number of lines to write per worker. Default: ${DEFAULTS.lines}
  --chunk-bytes <n>            Approximate bytes per write call. Default: ${DEFAULTS.chunkBytes}
  --delay-ms <n>               Delay between chunks. Default: ${DEFAULTS.delayMs}
  --label <text>               Label included in each line. Default: ${DEFAULTS.label}
  --stderr-every <n>           Write every nth line to stderr. Default: disabled
  --exit-code <n>              Exit code after writing output. Default: ${DEFAULTS.exitCode}
  --profile <name>             Output profile: ${Array.from(PROFILES).join(", ")}. Default: ${DEFAULTS.profile}
  --workers <n>                Spawn n child writers from this command. Default: ${DEFAULTS.workers}
  --worker-label-prefix <text> Label prefix for --workers children. Default: ${DEFAULTS.workerLabelPrefix}
  --forever                    Ignore --lines and write until killed
  -h, --help                   Show this help

Examples:
  npm run stress:terminal-output -- --lines 250000 --label tab-1
  node scripts/terminal-output-stress.js --lines 1000000 --chunk-bytes 32768
  node scripts/terminal-output-stress.js --workers 6 --lines 200000 --profile mixed --stderr-every 7
  node scripts/terminal-output-stress.js --workers 4 --forever --profile burst --chunk-bytes 65536
  node scripts/terminal-output-stress.js --profile progress --lines 50000 --delay-ms 1

Validation idea:
  Open the embedded terminal and run one --workers command to create heavily
  interleaved stdout/stderr, ANSI, Unicode, progress, and long-line output. For
  tab-specific testing, open many embedded terminal tabs and run this script in
  each tab with a different --label. The active tab should stream smoothly,
  inactive tabs should not crash the extension while their bounded history is
  still captured.
`;
}

function parseNonNegativeInteger(raw, name) {
  if (raw === undefined) throw new Error(`Missing value for ${name}`);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

function parsePositiveInteger(raw, name) {
  const value = parseNonNegativeInteger(raw, name);
  if (value < 1) throw new Error(`${name} must be at least 1`);
  return value;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, workerIndex: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--lines") {
      options.lines = parseNonNegativeInteger(argv[++index], arg);
    } else if (arg === "--chunk-bytes") {
      options.chunkBytes = parsePositiveInteger(argv[++index], arg);
    } else if (arg === "--delay-ms") {
      options.delayMs = parseNonNegativeInteger(argv[++index], arg);
    } else if (arg === "--label") {
      options.label = String(argv[++index] ?? "");
    } else if (arg === "--stderr-every") {
      options.stderrEvery = parseNonNegativeInteger(argv[++index], arg);
    } else if (arg === "--exit-code") {
      options.exitCode = parseNonNegativeInteger(argv[++index], arg);
    } else if (arg === "--profile") {
      options.profile = String(argv[++index] ?? "");
      if (!PROFILES.has(options.profile)) {
        throw new Error(`Unknown profile: ${options.profile}`);
      }
    } else if (arg === "--workers") {
      options.workers = 5; // parsePositiveInteger(argv[++index], arg);
    } else if (arg === "--worker-label-prefix") {
      options.workerLabelPrefix = String(argv[++index] ?? "");
    } else if (arg === "--forever") {
      options.forever = true;
    } else if (arg === "--worker-index") {
      options.workerIndex = parseNonNegativeInteger(argv[++index], arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    }
    function onDrain() {
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repeatToLength(seed, length) {
  if (length <= 0) return "";
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

function normalLine(label, lineNumber) {
  const padded = String(lineNumber).padStart(8, "0");
  const color = 31 + (lineNumber % 6);
  return `\x1b[${color}m${label}\x1b[0m line=${padded} cwd=${process.cwd()} payload=abcdefghijklmnopqrstuvwxyz0123456789\n`;
}

function unicodeLine(label, lineNumber) {
  return `${label} line=${String(lineNumber).padStart(8, "0")} unicode=é中🙂🚀 wide=コンニチハ combining=e\u0301 box=┌─┬─┐ arrows=←↑→↓\n`;
}

function longLine(label, lineNumber) {
  const payload = repeatToLength(
    `long-payload-${lineNumber}-abcdefghijklmnopqrstuvwxyz0123456789`,
    12_000 + (lineNumber % 17) * 137,
  );
  return `${label} line=${String(lineNumber).padStart(8, "0")} ${payload}\n`;
}

function ansiLine(label, lineNumber) {
  const color = 30 + (lineNumber % 8);
  const background = 40 + ((lineNumber + 3) % 8);
  return `\x1b[${color};${background};1m${label}\x1b[0m line=${String(lineNumber).padStart(8, "0")} clear-tail\x1b[K cursor-save\x1b7cursor-restore\x1b8 title=\x1b]0;${label}-${lineNumber}\x07\n`;
}

function progressLine(label, lineNumber) {
  const percent = String(lineNumber % 101).padStart(3, " ");
  const bar = repeatToLength("█", lineNumber % 40).padEnd(39, "░");
  const terminator = lineNumber % 25 === 0 ? "\n" : "\r";
  return `${label} progress ${percent}% [${bar}] tick=${lineNumber}${terminator}`;
}

function burstLine(label, lineNumber) {
  const linesInBurst = 1 + (lineNumber % 5);
  let output = "";
  for (let index = 0; index < linesInBurst; index += 1) {
    output += `${label} burst=${String(lineNumber).padStart(8, "0")} part=${index} payload=${repeatToLength("burst", 120)}\n`;
  }
  return output;
}

function makeLine(options, lineNumber) {
  const profile =
    options.profile === "mixed"
      ? ["normal", "unicode", "ansi", "progress", "long-lines", "burst"][
          lineNumber % 6
        ]
      : options.profile;

  if (profile === "unicode") return unicodeLine(options.label, lineNumber);
  if (profile === "long-lines") return longLine(options.label, lineNumber);
  if (profile === "ansi") return ansiLine(options.label, lineNumber);
  if (profile === "progress") return progressLine(options.label, lineNumber);
  if (profile === "burst") return burstLine(options.label, lineNumber);
  return normalLine(options.label, lineNumber);
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) {
    await waitForDrain(stream);
  }
}

function argsForWorker(options, workerIndex) {
  const args = [
    __filename,
    "--lines",
    String(options.lines),
    "--chunk-bytes",
    String(options.chunkBytes),
    "--delay-ms",
    String(options.delayMs),
    "--label",
    `${options.workerLabelPrefix}-${workerIndex}`,
    "--stderr-every",
    String(options.stderrEvery),
    "--exit-code",
    String(options.exitCode),
    "--profile",
    options.profile,
    "--worker-index",
    String(workerIndex),
  ];
  if (options.forever) args.push("--forever");
  return args;
}

async function runWorkers(options) {
  process.stdout.write(
    `[terminal-output-stress] spawning workers=${options.workers} profile=${options.profile} lines=${options.forever ? "forever" : options.lines}\n`,
  );

  const exits = await Promise.all(
    Array.from({ length: options.workers }, (_, index) => {
      const workerIndex = index + 1;
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          argsForWorker(options, workerIndex),
          {
            stdio: "inherit",
          },
        );
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          resolve({ workerIndex, code, signal });
        });
      });
    }),
  );

  const failed = exits.find((exit) => exit.code !== 0 || exit.signal);
  if (failed) {
    process.exitCode = failed.code ?? 1;
    process.stderr.write(
      `[terminal-output-stress] worker failed index=${failed.workerIndex} code=${failed.code} signal=${failed.signal}\n`,
    );
    return;
  }

  process.stdout.write("[terminal-output-stress] all workers completed\n");
}

async function runWriter(options) {
  const startedAt = Date.now();
  let lineNumber = 0;
  let stdoutBuffer = "";

  process.stdout.write(
    `[terminal-output-stress] start label=${options.label} worker=${options.workerIndex ?? 0} profile=${options.profile} lines=${options.forever ? "forever" : options.lines} chunkBytes=${options.chunkBytes} delayMs=${options.delayMs}\n`,
  );

  while (options.forever || lineNumber < options.lines) {
    lineNumber += 1;
    const line = makeLine(options, lineNumber);
    if (options.stderrEvery > 0 && lineNumber % options.stderrEvery === 0) {
      if (stdoutBuffer) {
        await writeChunk(process.stdout, stdoutBuffer);
        stdoutBuffer = "";
      }
      await writeChunk(process.stderr, line);
    } else {
      stdoutBuffer += line;
    }

    if (stdoutBuffer.length >= options.chunkBytes) {
      await writeChunk(process.stdout, stdoutBuffer);
      stdoutBuffer = "";
      if (options.delayMs > 0) await sleep(options.delayMs);
    }
  }

  if (stdoutBuffer) await writeChunk(process.stdout, stdoutBuffer);

  const durationMs = Math.max(1, Date.now() - startedAt);
  process.stdout.write(
    `[terminal-output-stress] done label=${options.label} worker=${options.workerIndex ?? 0} lines=${lineNumber} durationMs=${durationMs} linesPerSecond=${Math.round(
      (lineNumber / durationMs) * 1000,
    )}\n`,
  );
  process.exitCode = options.exitCode;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.workers > 1 && options.workerIndex === undefined) {
    await runWorkers(options);
    return;
  }
  await runWriter(options);
}

main().catch((error) => {
  process.stderr.write(`[terminal-output-stress] error: ${error.message}\n`);
  process.stderr.write(usage());
  process.exitCode = 1;
});
