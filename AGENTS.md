## Agent Rules

- Keep tests deterministic.
- Performance target: 60 FPS, <=16.67 ms/frame; UI work <=1–2 ms and avoid per-frame work unless needed.
- All commands must exit 0.
- Support Mac os and Linux

## Verification

- Before finishing, run `node verify.js --config verify.config.json`.
- It covers format, typecheck, tests, coverage, and compile.
- Pass requires exit 0 and every `STEP ... status=0`.
- On failure, use printed logs/error excerpts and `duration_ms`; fix and rerun.
- Commit exception: skip rerun only if verify already passed and files are unchanged since.
