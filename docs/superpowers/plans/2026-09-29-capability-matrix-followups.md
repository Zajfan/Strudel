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
- `launchChromium`'s 30 s timeout on the DevTools listening line can orphan the child process if it fires.
- Browser-server test temp dirs are not cleaned up after the test run.
- `m.stop()` in PERF-1/LIVE-1 (browser) runs inside the `try` block instead of `finally`, so a failed assertion can leak the running pattern.
- `page-recorder` builds its worklet/DOM nodes before entering its `try`, so a failure there escapes the same cleanup path.
- PLUG-1's `ENOENT` (Surge XT not found) error path omits `notes.pattern`, and `patternToNoteEvents` is otherwise unguarded against a throwing pattern.
- The Rust-side boundary delivery in the PLUG-1 CLAP spike (clack-host loading the real plugin and playing the derived events) is verified only manually, not by an automated check.
- EXP-2 (browser) checks the residual-dBFS threshold before checking whether a stem export API exists, so a missing API and a failing residual read the same on a quick glance.
- No test pins `RAMP_DETECTION_DB`, so a future edit to that constant would silently change what AUT-1 accepts as "stepped only" vs. a ramp.

## From the complete probe set (2026-09-29)

Full three-tier run, all cells re-measured this date (see `tools/capabilities/results/2026-09-29-{cli,desktop,browser}.json` and `MATRIX.md`). Every non-`pass` cell, grouped by the roadmap sub-project it belongs to.

### Sub-project 1 — Arrangement layer (ARR)
- **ARR-1 (cli, browser: fail):** `arrange()` loops; there is no hard-ending construct. The probe finds 8 events still playing after bar 64 of the intended 64-bar, 8-section song.
- **ARR-1 (desktop: not-run):** no probe yet.

### Sub-project 2 — Mixer and routing (MIX, CUE)
- **MIX-1 (cli: fail):** supradough (the CLI engine) has no ducking or bus routing at all — the measured drop is 0.2 dB against a 6 dB threshold.
- **MIX-1 (browser: not-run, partial):** live ducking works — median drop ~31-33.5 dB across runs, well past the 6 dB threshold — measured with an AudioWorklet tap on the master mix around each orbit-2 trigger start. But the offline export path (`renderPatternAudio`) is not export-faithful: superdough fires `duck()` from a main-thread `webAudioTimeout` callback, so in a chunked offline render the duck lands wherever the main thread happens to catch up — at a render-chunk boundary, or past the render entirely — instead of at the trigger sample. Measured `offlineDropDb` has ranged 0.2–7.6 dB across runs (34.7 dB in today's run, by coincidence of where the chunk boundary landed) instead of tracking the ~31 dB live figure. This is an export-fidelity bug, not a mixing-capability gap. Separately, the 4-buses-plus-send part of the MIX-1 criterion is not observable in a two-channel stereo mix and remains unverified by this probe.
- **MIX-1 (desktop: not-run):** no probe yet.
- **CUE-1 (browser: fail):** `setSinkId` exists (routing the whole output to a second device works), but there is no per-pattern cue output — one output device serves all patterns, so a pattern cannot be cued to headphones while the mix continues on the main output.
- **CUE-1 (desktop: not-run):** no probe yet.

### Sub-project 3 — Automation (AUT)
- **AUT-1 (cli, browser: fail):** automation values are sampled once per event, not continuously. The probe holds a note across a ramp and measures a 0 dB change in level within the held note ("stepped only") — onset timing of the 16 stepped values is accurate (worst case ~0.08 ms), but there is no interpolation between them.
- **AUT-1 (desktop: not-run):** no probe yet.

### Sub-project 4 — Offline render and export (EXP)
- **EXP-1 (cli, browser: fail):** non-deterministic. Two renders of the same pattern differ starting at sample 0; the suspected cause is `Math.random()` in the supradough noise generators (`packages/supradough/dough.mjs:196-228`) and the supersaw phase init (`:103`) — the reference song exercises the noise path.
- **EXP-1 (desktop: not-run):** no probe yet.
- **EXP-2 (cli, browser: fail, opt in browser):** no stem export API exists. Feasibility check: summing the per-orbit renders reproduces the full mix to within -169 dBFS residual, so stems are achievable once an export API exists — this is a missing-API gap, not an engine limitation.
- **EXP-2 (desktop: not-run):** no probe yet.

### Sub-project 5 — Instrument depth (TUNE)
- TUNE-1 passes on cli and browser (max deviation ~0.0000010 cents against a ±1 cent threshold).
- **TUNE-1 (desktop: not-run):** no probe yet.

### Sub-project 6 — Performance hardening (PERF)
- PERF-1 passes on cli (4.4x real time against the 4x threshold) and browser (64 voices, 0 late starts, 0 silent windows).
- **PERF-1 (desktop: not-run):** no probe yet.

### Sub-project 7 — Integration: MIDI, OSC, Link, headless and native runtime (SYNC, PLUG)
- **SYNC-1 (browser: not-run):** headless Chromium has no MIDI output devices to measure clock-out jitter against.
- **SYNC-1 (cli, desktop: not-run):** no probe yet.
- **PLUG-1 (desktop: not-run):** Surge XT is not installed on this machine, so the probe has nothing to host. Separately, a throwaway Rust `clack-host` spike (`tools/capabilities/spikes/`, outside the probe run) loaded the real Surge XT.clap (extracted from the RPM, not installed) and played the 8 note-on/off events derived from the Strudel pattern `note("c4 e4 g4 c5")`, producing non-silent output (rms 0.084). That confirms CLAP hosting from a Rust backend works end-to-end (Strudel pattern → note events → CLAP plugin → audio); the cell itself stays `not-run` until Surge XT is actually installed so the probe can exercise it directly. To install:
  ```sh
  wget https://github.com/surge-synthesizer/releases-xt/releases/download/1.3.4/surge-xt-x86_64-1.3.4.rpm
  sudo dnf install ./surge-xt-x86_64-1.3.4.rpm
  ```
  This installs the plugin to `/usr/lib64/clap/Surge XT.clap`, which is one of the paths PLUG-1 already searches.
- **PLUG-1 (cli: not-run, opt):** no probe yet.

### Language front end (LANG)
- **LANG-1 (cli, browser: fail):** 1 of 2 exact. The syntax-error case reports the exact line and column (3:12, from `err.loc`). The unknown-function case does not: it reports the transpiled/compiled column (3:78, from the stack trace) instead of the user's source column (3:3), because the error is thrown from generated code and located by stack-frame heuristics rather than a source map back to the original pattern text.
- **LANG-1 (desktop: not-run):** no probe yet.
