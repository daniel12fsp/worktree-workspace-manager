## Agent Rules

- Keep tests deterministic.
- Performance target: 60 FPS, <=16.67 ms/frame; UI work <=1–2 ms and avoid per-frame work unless needed.
- All commands must exit 0.
- Support Mac os and Linux.
- Preserve keyboard input everywhere: typing must work in the embedded terminal, including after it loses DOM focus, without stealing keystrokes from extension inputs or other VS Code editors and terminals. A prior regression dropped embedded-terminal input after focus changes, so keyboard/focus changes require regression tests for both terminal fallback input and editable-control isolation.

## Verification

- Before finishing, run `node verify.js --config verify.config.json`.
- It covers format, typecheck, tests, coverage, and compile.
- Pass requires exit 0 and every `STEP ... status=0`.
- On failure, use printed logs/error excerpts and `duration_ms`; fix and rerun.
- Commit exception: skip rerun only if verify already passed and files are unchanged since.
