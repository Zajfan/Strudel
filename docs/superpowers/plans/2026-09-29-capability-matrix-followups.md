# Capability matrix: follow-ups from execution

Deferred findings from the reviews of `2026-09-28-capability-matrix-foundation.md`.
None blocked the merge; each names where it should be fixed.

## Must fix with sub-project 4 (render/export)
- **EXP-1 length/WAV check is not real.** `expectedLength` uses the same formula
  that sizes the render buffer, so it cannot fail, and no WAV is encoded. When
  determinism is fixed, EXP-1 would pass without checking these. Encode a WAV,
  compare WAV bytes, and check the length independently of `renderPattern`.
- **EXP-1 non-determinism** comes from `Math.random()` in the supradough noise
  generators (`packages/supradough/dough.mjs:196-228`) and supersaw phase init (`:103`).
  The error message names supersaw, but the reference song only uses noise.

## Before PERF-1 is trusted
- PERF-1 times only the DSP loop, in one cold run. Results so far: 4.5x, then 3.93x,
  against a 4x threshold. Time end-to-end, warm up, and take the median of several runs.

## Runner and matrix polish
- If git fails, the provenance record drops `commit` and `dirty` instead of recording "unknown".
- `isStale` compares with `JSON.stringify`, so reordering threshold keys gives a false stale.
- `dirty` is always true while uncommitted work sits under `packages/`.
- The results file date is in UTC.
- `--ingest` is also accepted for the cli and desktop tiers.
- A `|` in a headline is not escaped in the table.
- `metrics` and `notes` are not coerced to objects.
- `ctx.tmpDir` is the bare OS temp dir. Namespace it before any probe writes scratch files.
- `ingest` with an unknown id exits 1 with a stack trace; argument errors exit 2.
- EXP-1 and PERF-1 duplicate their setup. Extract a helper when a third render probe lands.
- Desktop BUILD-0 drops `logTail` on pass and is a `cargo check`, not a full `tauri build`.
- `@strudel/core` prints "cannot use window" when loaded in Node.
