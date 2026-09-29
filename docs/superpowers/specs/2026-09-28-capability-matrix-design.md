# Capability matrix and ceiling probes — design

Sub-project #0 of the "Strudel at full potential" roadmap.

## Goal

Strudel should reach FL Studio-level capability, expressed as a programming
language rather than a DAW. A DAW (Strudel-di) comes later, and only once the
language is there. Porting to NexusLang (`.nxl`) is the fallback if Strudel hits
limits that engineering cannot remove.

This sub-project turns "full potential" into measurable pass/fail criteria. It
also answers early, on evidence, whether and where Strudel hits a hard limit.

## Roadmap context

| # | Sub-project |
|---|---|
| **0** | **Capability matrix and ceiling probes (this spec)** |
| 1 | Arrangement layer: song, section and clip abstractions |
| 2 | Mixer and routing: buses, sends, effect chains, sidechain, cue output |
| 3 | Automation: parameter curves, sample-accurate |
| 4 | Offline render and export: WAV, stems |
| 5 | Instrument depth: sampler, slicing, time-stretch, synthesis, tuning |
| 6 | Performance hardening |
| 7 | Integration: MIDI, OSC, Link, headless and native runtime |

Each `fail` found by #0 becomes input for sub-projects 1–7. Sub-project #0 fixes
nothing itself.

## Tiers

| Tier | Runtime | Engine today |
|---|---|---|
| Browser | Web REPL (`website/`) | superdough (Web Audio), dough (WASM worklet) |
| Desktop | Tauri app (`src-tauri/`, Rust) | browser engines plus native MIDI and OSC bridges |
| CLI | Headless Node | supradough (`packages/supradough/dough-export.mjs` WAV PoC) |

Each capability is marked `req`, `opt` or `n/a` per tier.

## Statuses

- `pass`: the criterion is met, with metrics recorded.
- `fail`: the criterion is not met yet, but no platform limit is shown. This is engineering work.
- `wall`: a platform limit prevents it. `notes.evidence` must name the limit
  (API, spec, OS constraint) and cite a source or a minimal reproduction.
- `not-run`: never counts as a pass.

A probe that observes zero events or zero signal reports `fail`, never `pass`.

## NexusLang decision rule

- **Walls in `n/a` cells do not count.**
- **A wall in a `req` cell of the Desktop or CLI tier triggers a port review** for
  that capability.
- The kind of wall decides the kind of port:
  - Walls only in language rows (`ARR`, `LANG`, `TUNE`) → NexusLang as a **new
    front end** compiling to the existing engine.
  - Walls in engine rows (`PERF`, `AUT`, `MIX`, `PLUG`, `SYNC`, `CUE`) → the engine
    needs a **native rewrite**, possibly still driven by Strudel.
- Browser-only walls are expected and never trigger a port. The Browser tier is a
  defined subset.
- **First fallback for engine walls: VersaTone.** The user's own C++23 engine
  ("DAWG", `Nexus-Systems/apps/VersaTone`) is the first candidate, before any
  native rewrite. It runs as a separate process driven over OSC, the way Strudel
  already drives SuperDirt. VersaTone is proprietary and Strudel is AGPL-3.0, so
  linking them into one binary requires relicensing first. Its capacity claims
  are unmeasured; the same probes apply to it before it is adopted.

## Initial matrix

Thresholds live in `tools/capabilities/capabilities.json`. The values below are
the initial ones. A threshold changes only by editing this spec and the JSON in
the same commit, never inside a probe.

| ID | Capability | Pass criterion | Browser | Desktop | CLI |
|---|---|---|---|---|---|
| ARR-1 | Long-form song | 64-bar, 8-section piece with a hard ending in one file; renders with the correct section boundaries | req | req | req |
| MIX-1 | Buses, send, sidechain | 4 buses, one send, one ducked bus; ducking depth ≥ 6 dB measured on the output | req | req | req |
| AUT-1 | Automation precision | Parameter ramp timing error < 1 ms at 48 kHz | req | req | req |
| EXP-1 | Offline render | Reference song renders to WAV: non-silent (RMS ≥ 0.001; minRms applies to CLI and browser), correct length, byte-identical across two runs | req | req | req |
| EXP-2 | Stems | One WAV per bus; the stems sum to the mix within −60 dBFS residual | opt | req | req |
| PERF-1 | Voice capacity | Sustained polyphony (saw + filter + envelope) for 60 s with 0 late starts: Browser ≥ 64, Desktop ≥ 256; CLI renders the reference song ≥ 4× real time | req | req | req |
| LIVE-1 | Safe live swap | A failing evaluation mid-playback causes no audio gap > 1 render quantum (128 frames); the previous pattern continues | req | req | n/a |
| CUE-1 | Headphone cue | A pattern can be routed to a second output device, inaudible on the main output | opt | req | n/a |
| PLUG-1 | Third-party plugin | Load a CLAP or VST3 instrument, play notes from a pattern, and capture non-silent output (RMS ≥ 0.001; minRms applies to desktop) | n/a | req | opt |
| SYNC-1 | External clock | MIDI clock-out jitter < 2 ms over 60 s | opt | req | opt |
| TUNE-1 | Microtonal | 19-EDO and a just-intonation scale usable in pattern code; pitches within ±1 cent | req | req | req |
| LANG-1 | Error quality | A syntax error and an unknown function each report the exact line and column | req | req | req |
| BUILD-0 | Tier builds | The tier builds from a clean checkout with the documented toolchain | req | req | req |

Known lead: `src-tauri/Cargo.toml` pins `tauri = "1.4.0"` next to
`tauri-plugin-clipboard-manager = "2"` (a Tauri v2 plugin). Desktop BUILD-0 may fail.

## Layout

All under `tools/capabilities/`. None of this is application code.

```
capabilities.json        # matrix spec: id, criterion, thresholds, per-tier req/opt/n/a
probes/cli/<ID>.mjs      # Node probes
probes/browser/<ID>.mjs  # Node modules that drive the page over CDP (ctx.page)
probes/desktop/<ID>.mjs  # drive cargo / the Tauri app / native spikes
run.mjs                  # node tools/capabilities/run.mjs --tier cli|browser|desktop [--only ID]
results/<date>-<tier>.json
MATRIX.md                # generated scoreboard
```

### Probe contract

```js
export async function probe(ctx) {
  // ctx: { thresholds, tier, tmpDir, log }
  return { status: 'pass' | 'fail' | 'wall' | 'not-run', metrics: {}, notes: {} };
}
```

A probe that throws is recorded as `fail`, with the error kept in `notes.error`.
The runner validates that every `req` or `opt` cell has a result, and records
missing probes as `not-run`.

### Browser tier

*Amended 2026-09-29: automation is now in scope.* `run.mjs --tier browser` serves
`website/dist` locally with the cross-origin isolation headers from
`website/astro.config.mjs`, launches the headless Chromium already present in the
Playwright cache (`~/.cache/ms-playwright`), and drives it over the Chrome DevTools
Protocol using Node's built-in `WebSocket`. No new dependencies. Browser probes are
Node modules (`probes/browser/<ID>.mjs`) that evaluate code in the page via `ctx.page`.
`--ingest` stays available for results produced by hand in a real browser.
Headless Chromium has a fake audio device and no MIDI devices, so SYNC-1 reports
`not-run` there, and live-playback measurements observe Web Audio scheduling and
rendered signal, not physical speaker output.

### Desktop tier

Desktop probes run `cargo` and standalone throwaway Rust binaries under
`tools/capabilities/spikes/`. PLUG-1 starts as a spike: can a Rust host crate
(for example `clack-host` for CLAP) load a plugin and render audio? A yes means
the capability is reachable through the Tauri backend. A demonstrated no is
recorded as a wall with evidence. *Amended 2026-09-29:* the plugin under test is
Surge XT (open-source, ships CLAP), installed by the user from the official RPM.
While it is absent, PLUG-1 reports `not-run`.

## First probe order

1. CLI/EXP-1: deterministic WAV render through supradough.
2. Desktop/BUILD-0: `cargo check` in `src-tauri`.
3. CLI/AUT-1, CLI/MIX-1: measured on rendered audio.
4. CLI/PERF-1: render speed relative to real time.
5. Desktop/PLUG-1: throwaway CLAP-hosting spike.
6. Browser/PERF-1, Browser/AUT-1, Browser/LIVE-1: reuse `tools/baseline`.
7. The remaining cells.

## Prerequisites

- Node 22 (`.nvmrc`); the repo root currently has no `node_modules`, so run `pnpm install` first.
- Rust toolchain (available locally).
- The browser tier needs a local Chromium or Chrome build. None is on `PATH` now.

## Out of scope

- Fixing any capability.
- Upstreaming anything to `codeberg.org/uzu/strudel`.

## Licensing note

Strudel is AGPL-3.0. A NexusLang that translates or incorporates Strudel code, or
a front end distributed together with its engine, is a derivative work and must
be AGPL-3.0 as well.

## Remotes

`upstream` = `https://codeberg.org/uzu/strudel` (pull only), `origin` =
`https://github.com/Zajfan/Strudel` (the user's fork).
