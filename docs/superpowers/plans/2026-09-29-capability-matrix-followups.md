# Capability matrix: follow-ups from execution

Deferred findings from the reviews of `2026-09-28-capability-matrix-foundation.md`.
None blocked the merge; each names where it should be fixed.

## Must fix with sub-project 4 (render/export)
- **EXP-1 length/WAV check is not real.** `expectedLength` uses the same formula
  that sizes the render buffer, so it cannot fail, and no WAV is encoded. When
  determinism is fixed, EXP-1 would pass without checking these. Encode a WAV,
  compare WAV bytes, and check the length independently of `renderPattern`.
  - **Done 2026-10-02:** both probes now check an encoded WAV. CLI: `encodeWav` (`packages/supradough/render.mjs`) encodes both renders, the WAV files must be byte-identical, and the length is read from the WAV header. Browser: the WAV blob `renderPatternAudio` hands to the download link is captured; its header must say 2 ch at 48 kHz with the song's length, and the file size must match the header.
- **EXP-1 non-determinism** comes from `Math.random()` in the supradough noise
  generators (`packages/supradough/dough.mjs:196-228`) and supersaw phase init (`:103`)
  on the CLI, and in superdough's noise buffers (`packages/superdough/noise.mjs`) in the
  browser. The error message names supersaw, but the reference song only uses noise.
  - **Done 2026-10-02:** supradough takes a seed (`new Dough(sampleRate, currentTime, seed)`), and offline renders are seeded, so the CLI render is byte-identical. The browser difference was not randomness: Chromium sums a node's inputs in an order that can change between renders (shown with three plain OscillatorNodes into one GainNode), so float sums differ by up to -81.5 dBFS on the reference song. Browser EXP-1 now requires renders to match within -60 dBFS (agreed 2026-10-02); superdough's `Math.random()` uses (noise buffers, reverb IR, supersaw/wavetable phase) are not seeded yet.

## Before PERF-1 is trusted
- PERF-1 times only the DSP loop, in one cold run. Results so far: 4.5x, then 3.93x,
  against a 4x threshold. Time end-to-end, warm up, and take the median of several runs.
  A CLI pass sits inside that documented 3.93–4.5x single-run spread, so the cell is
  flappy: a pass or fail on one run is not evidence either way.

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
- Browser-server test temp dirs are not cleaned up after the test run.
- PLUG-1's `ENOENT` (Surge XT not found) error path omits `notes.pattern`, and `patternToNoteEvents` is otherwise unguarded against a throwing pattern.
- The Rust-side boundary delivery in the PLUG-1 CLAP spike (clack-host loading the real plugin and playing the derived events) is verified only manually, not by an automated check.
- EXP-2 (browser) checks the residual-dBFS threshold before checking whether a stem export API exists, so a missing API and a failing residual read the same on a quick glance.
- Verdict logic is inline in each probe. Only ARR-1 (`judgeArrangement`) and EXP-2
  (`judgeStems`) have tested verdict helpers; extract a `judgeX` for every probe.
- MIX-1 has no control run without `duckorbit`, and measures channel 0 only.
- A `wall` only needs a truthy `notes.evidence`; its depth (what was tried, where the
  limit lives) is not checked.
- EXP-2 feasibility wording: the stem pattern has no shared bus effects (delay, reverb on a
  bus), so "stems sum to the mix" is shown only for dry orbits.
  - **Done 2026-10-02:** the stem pattern now has a delay on orbit 2, and both stem APIs are exercised against a separate mix render.
- PLUG-1: `eventsDelivered` is a host-side count, not an acknowledgement from the plugin;
  RMS is not correlated with the note windows; a cargo timeout does not kill the
  `clap-host` child; the spike hand-rolls its JSON output although `serde_json` is a dependency.

## From the complete probe set (2026-09-29)

Full three-tier run, all cells re-measured this date after the final-review fixes (see `tools/capabilities/results/2026-09-29-{cli,desktop,browser}.json` and `MATRIX.md`). Every non-`pass` cell, grouped by the roadmap sub-project it belongs to.

### Sub-project 1 — Arrangement layer (ARR)
- ARR-1 passes on cli and browser via `arrange(...).filterWhen((t) => t < 64)`: 64 events in the song, 0 in the wrong section, 0 after bar 64. `arrange(...sections, [1e6, silence])` also ends correctly within the probe window (it loops again only after 10^6 cycles). Ergonomics gap: bare `arrange()` loops (8 events after bar 64), so a hard ending needs one of these extra constructs; there is no dedicated "end" in the arrangement syntax.
  - **Addressed 2026-10-02:** `arrange(...).once()` plays the song through once and ends; when played, the transport stops by itself once everything up to the end is scheduled (already scheduled notes still sound). `arrange` records its length as `_period`, `once()` its end as `_end`; both are carried through value-only operations (controls, `fmap`, context, filters, query state) and a `stack` ends when all its layers do. Time-changing operations (`fast`, `early`, ...) drop them, and then `once()` plays one cycle. ARR-1 now passes via `arrange().once()`; the browser probe also checks that the transport stops.
- **ARR-1 (desktop: not-run):** no probe yet.

### Sub-project 2 — Mixer and routing (MIX, CUE)
- **MIX-1 (cli: fail):** supradough (the CLI engine) has no ducking or bus routing at all — the measured drop is 0.2 dB against a 6 dB threshold.
- **MIX-1 (browser: not-run, partial):** live ducking works — median drop ~31-33.5 dB across runs, well past the 6 dB threshold — measured with an AudioWorklet tap on the master mix around each orbit-2 trigger start. But the offline export path (`renderPatternAudio`) is not export-faithful: superdough fires `duck()` from a main-thread `webAudioTimeout` callback, so in a chunked offline render the duck lands wherever the main thread happens to catch up — at a render-chunk boundary, or past the render entirely — instead of at the trigger sample. Measured `offlineDropDb` has varied 0.2–34.7 dB across runs (16.0 dB in the final run) instead of tracking the ~31 dB live figure. This is an export-fidelity bug, not a mixing-capability gap. Separately, the 4-buses-plus-send part of the MIX-1 criterion is not observable in a two-channel stereo mix and remains unverified by this probe.
- **MIX-1 (desktop: not-run):** no probe yet.
- **CUE-1 (browser: fail):** `setSinkId` exists (routing the whole output to a second device works), but there is no per-pattern cue output — one output device serves all patterns, so a pattern cannot be cued to headphones while the mix continues on the main output.
- **CUE-1 (desktop: not-run):** no probe yet.

### Sub-project 3 — Automation (AUT)
- **AUT-1 (cli, browser: fail):** automation values are sampled once per event, not continuously. The probe holds a note across a ramp and measures a 0 dB change in level within the held note ("stepped only") — onset timing of the 16 stepped values is accurate (worst case ~0.08 ms), but there is no interpolation between them. When a ramp appears, the cell becomes `not-run` (partial: ramp timing not measured) until the probe times the ramp itself.
- **AUT-1 (desktop: not-run):** no probe yet.

### Sub-project 4 — Offline render and export (EXP)
- **EXP-1 (cli, browser: fail):** non-deterministic. Two renders of the same pattern first differ at sample 1 on both tiers. On the CLI the cause is `Math.random()` in the supradough noise generators (`packages/supradough/dough.mjs:196-228`; the supersaw phase init at `:103` is not used by the reference song). In the browser it is `Math.random()` in superdough's noise buffers (`packages/superdough/noise.mjs`).
- **EXP-1 (desktop: not-run):** no probe yet.
- **EXP-2 (cli, browser: fail, opt in browser):** no stem export API exists (names are matched as the word "stem"/"stems", so `system…` no longer counts; an API that is found but not driven by the probe is `not-run`, never `pass`). Feasibility check: summing the per-orbit renders reproduces the full mix to within -169 dBFS residual, so stems are achievable once an export API exists — this is a missing-API gap, not an engine limitation.
  - **Fixed 2026-10-02 (cli, browser: pass).** Browser: `renderPatternStems` (`packages/webaudio/webaudio.mjs`) renders once into an OfflineAudioContext with 2 channels per orbit (multiChannelOrbits routing), and splits it into one stereo stem per orbit (1 to 16) plus their sum; `exportPatternStems` downloads them as one zip (fflate, stored); the Export tab has a "Stems" option. CLI: supradough now has one delay per orbit (it had one delay shared by all orbits, using the settings of whichever voice was updated last) and `renderDoughStems` reads every orbit's output in one pass. Residuals against a separate mix render: -154.6 dBFS (browser), -168.9 dBFS (CLI). The per-orbit buses cost about 2.5% render speed (CLI PERF-1 4.2x, limit 4x).
- **EXP-2 (desktop: not-run):** no probe yet.

### Sub-project 5 — Instrument depth (TUNE)
- TUNE-1 passes on cli and browser (max deviation ~0.0000010 cents against a ±1 cent threshold).
- **TUNE-1 (desktop: not-run):** no probe yet.

### Sub-project 6 — Performance hardening (PERF)
- PERF-1 passes on cli (4.37x real time against the 4x threshold) and browser (64 voices, 1984 starts against 1856 expected, 0 late starts, 0 haps dropped as past-due, 0 silent windows). The CLI pass sits inside the documented 3.93–4.5x single-run spread, so it is flappy (see "Before PERF-1 is trusted"). Browser lateness now also counts superdough's "cannot schedule sounds in the past" warnings, because superdough drops those haps before `start()`.
- **LIVE-1 (browser: fail):** 2 of 3 failure kinds are safe. A syntax error and a throw during evaluation leave the previous pattern playing (12 starts after the failure, same pitch, 0 frames of audio gap beyond the pattern's own silence). A pattern that throws when the scheduler queries it (`.fmap(() => { throw ... })`) replaces the running pattern: the cyclist catches the error on every tick and plays nothing (0 starts after the failure, a 126508-frame, ~2.6 s silent gap to the end of the recording). The error is only logged (`[query] error: ...`), not surfaced in `repl.state.error`.
  - **Fixed 2026-10-02 (browser: pass, 3/3 cases, 0 frame gap).** Root cause: `Pattern.queryArc` catches query errors and returns `[]`, so the cyclist never saw them. Cyclist and NeoCyclist now query through `packages/core/fallbackquery.mjs`, which reports the error once and reverts to the last pattern that queried cleanly; the REPL surfaces it as `schedulerError`. The probe's throw messages are now single-quoted (the transpiler turns double-quoted strings into mini-notation, which made them read `Error: [object Object]`). Remaining: a pattern with nothing to fall back to (the first one evaluated, or one that broke after its fallback was used) still plays silence and reports its error every tick.
- **PERF-1 (desktop: not-run):** no probe yet.

### Sub-project 7 — Integration: MIDI, OSC, Link, headless and native runtime (SYNC, PLUG)
- **SYNC-1 (browser: not-run):** headless Chromium has no MIDI output devices to measure clock-out jitter against.
- **SYNC-1 (cli, desktop: not-run):** no probe yet.
- **BUILD-0 (desktop: fail):** `cargo check --locked` in `src-tauri` fails dependency resolution: `tauri = "1.4.0"` sits next to `tauri-plugin-clipboard-manager = "2"` (a Tauri v2 plugin, which pulls in `tauri v2`), and the two need incompatible `memchr` versions. This blocks every desktop cell: no desktop probe can build the app.
- **PLUG-1 (desktop: not-run):** Surge XT is not installed on this machine, so the probe has nothing to host. Separately, a throwaway Rust `clack-host` spike (`tools/capabilities/spikes/`, outside the probe run) loaded the real Surge XT.clap (extracted from the RPM, not installed) and played the 8 note-on/off events derived from the Strudel pattern `note("c4 e4 g4 c5")`, producing non-silent output (rms 0.084). That confirms CLAP hosting from a Rust backend works end-to-end (Strudel pattern → note events → CLAP plugin → audio); the cell itself stays `not-run` until Surge XT is actually installed so the probe can exercise it directly. To install:
  ```sh
  wget https://github.com/surge-synthesizer/releases-xt/releases/download/1.3.4/surge-xt-x86_64-1.3.4.rpm
  sudo dnf install ./surge-xt-x86_64-1.3.4.rpm
  ```
  This installs the plugin to `/usr/lib64/clap/Surge XT.clap`, which is one of the paths PLUG-1 already searches.
- **PLUG-1 (cli: not-run, opt):** no probe yet.

### Language front end (LANG)
- **LANG-1 (cli, browser: fail):** 1 of 2 exact. All columns are 0-based (acorn's convention; V8's 1-based stack columns are converted). The syntax-error case reports the exact line and column (3:12, from `err.loc`). The unknown-function case does not: it reports 3:77 (from the stack trace of the transpiled code) instead of the user's source column 3:3, because the error is thrown from generated code and located by stack-frame heuristics rather than a source map back to the original pattern text.
  - **Fixed 2026-10-02 (cli: pass, 2/2 exact).** Evaluated code is tagged `//# sourceURL=strudel-eval.js` and starts on its own line (`packages/core/evaluate.mjs`), so its stack frames are found in any engine; the transpiler maps a frame's generated position back to the user's code through an escodegen source map, built only when an error needs it (`originalPosition` in `packages/transpiler/transpiler.mjs`). Runtime errors get `err.loc` and a ` (line:column)` message suffix, like acorn's syntax errors. Mini-notation parse errors now carry `err.loc` too (they only named the line), and generated `m(...)` calls map to their string.
  - Not covered: block-based evaluation reports positions relative to the block (as acorn already did), and mini parse errors in block mode get no location.
- **Found while fixing LANG-1:** `evalScope(core, mini)` copies every export onto `globalThis`, and `@strudel/mini` exports the krill parser's `SyntaxError`, so the global `SyntaxError` becomes `peg$SyntaxError` and `err instanceof SyntaxError` is false for JavaScript syntax errors in user code. **Fixed 2026-10-02:** `@strudel/mini` re-exports the parser error as `MiniSyntaxError` (`packages/mini/index.mjs`); `packages/mini/test/scope.test.mjs` checks that no mini export shadows a JS built-in. A static check of the other packages found no other collisions; `evalScope` itself is unchanged, since in the browser `globalThis` includes window properties that Strudel may deliberately override.
- **LANG-1 (desktop: not-run):** no probe yet.
