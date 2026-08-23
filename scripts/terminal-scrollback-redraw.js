#!/usr/bin/env node
"use strict";

const SCREEN_COUNT = 100;
const LINES_PER_SCREEN = 4;
const REDRAW_DELAY_MS = 100;
const CLEAR_AND_HOME = "\x1b[2J\x1b[H";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function screenOutput(screenNumber) {
  const lines = [
    "terminal scrollback redraw fixture",
    `screen ${screenNumber}/${SCREEN_COUNT}`,
    `history marker ${String(screenNumber).padStart(2, "0")}`,
    "After screen 12, scroll up for earlier screens.",
  ];
  if (lines.length !== LINES_PER_SCREEN) {
    throw new Error("Unexpected redraw fixture line count");
  }
  return `${CLEAR_AND_HOME}${lines.join("\n")}`;
}

async function main() {
  for (let screenNumber = 1; screenNumber <= SCREEN_COUNT; screenNumber += 1) {
    process.stdout.write(screenOutput(screenNumber));
    if (screenNumber < SCREEN_COUNT) await sleep(REDRAW_DELAY_MS);
  }
  process.stdout.write("\n");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
