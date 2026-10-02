# Native desktop audio (cue output, then live CLAP hosting)

Decided 2026-10-02: the desktop app gets a native audio engine in its Rust backend, used until the
user's VersaTone engine is complete; then the backend side is swapped for VersaTone. Patterns and
superdough must not depend on which engine sits behind it.

## Why

WebKitGTK (the desktop webview) cannot play to a second output device (no `setSinkId`; CUE-1 is a
`wall` on desktop) and cannot host plugins. Both need audio that leaves the webview.

## Seam (what VersaTone will replace)

- superdough gets a **cue-output provider** interface: `{ create(audioContext) -> { destination,
  setDevice(name), disconnect() }, listDevices() }`. `setCueOutputProvider(provider)` replaces the
  default (MediaStream + `<audio>` + `setSinkId`). superdough never imports Tauri.
- `@strudel/desktopbridge` registers the native provider when running in Tauri.
- The Rust side is a module `src-tauri/src/audio/` with Tauri commands; VersaTone would implement
  the same commands (or the bridge would talk OSC to it instead).

## Step 1: native cue output (CUE-1 desktop) — done 2026-10-02

- JS: an AudioWorklet `cue-tap` receives the cue mix and posts interleaved Float32 chunks
  (~20 ms) to the page, which sends them to Rust as raw bytes (`cue_write`).
- Rust: `cue_start(device, sampleRate, channels)` opens a cpal output stream on the named device;
  `cue_write` pushes samples into a lock-free ring buffer (rtrb) the audio callback reads from.
  A jitter buffer (target ~60 ms) absorbs IPC bursts; drift between the webview's audio clock and
  the device clock is corrected by dropping or repeating single frames when the fill leaves its band.
  `cue_devices()` lists output devices; `cue_stop()`; `cue_stats()` (underruns, fill, frames).
- Verification: `cue_capture(seconds)` returns the frames the callback actually handed to the
  device. The desktop CUE-1 probe plays to ALSA's `null` device (silent), and checks with the same
  tone analysis as the browser: cue present in the captured device output, absent from the main mix.

## Step 2: live CLAP hosting (PLUG-1 desktop, live) — done 2026-10-02

- `.clap('Surge XT')` (or a `plugin` control) marks a pattern for the native engine: its note
  events go to Rust with absolute Unix-epoch times (as the MIDI bridge does).
- Rust hosts one plugin instance per name (clack-host, from the PLUG-1 spike), renders in a cpal
  output callback, applies events at their sample offsets, accounting for output latency.
- Verification: a capture like `cue_capture`, checked for the pattern's notes at the right times.

## Not done yet

- Done 2026-10-02: a "Plugin Output Device" setting (desktop only; `setPluginDevice`), and unloading
  (`unloadClap`, `loadedClaps`): the audio thread stops the plugin's processor and hands it back to
  its host thread, which deactivates and unloads it. A device change unloads all plugins, moves the
  stream and reloads them.
- Done 2026-10-02: plugins in Strudel's mixer, the default for `.clap()`. The page plays each plugin
  as a stream (an AudioWorklet player per plugin) through superdough's `getExternalChannel`, so
  orbit-level controls apply (orbit, gain, pan, delay, room, ducking, cue, stems) and there is one
  output. Rust renders on request (`mix_load`, `mix_notes`, `mix_render`, src-tauri/src/audio/mixer.rs)
  for frames of the page's audio clock, at most ~60 ms ahead (notes come ~100 ms early); notes are
  placed at their exact frame. Measured: plugin notes within 1.5 ms of superdough notes scheduled at
  the same times (Surge XT's own 16-frame blocks and attack). `.clap(name, { output: 'native' })`
  keeps the native output (lower latency, no Strudel effects).
- Per-voice controls (filters, envelopes) don't apply to a plugin stream; exports (offline renders)
  don't include plugins yet (the player pulls asynchronously).
- Done 2026-10-02: plugin parameter automation in the mixer. A plugin's automatable parameters are
  read at load (CLAP params; `clapParams(name)` lists them, Surge XT: 598), and an `.auto()` curve
  whose control names a parameter is sent as timed plain values (`mix_params`) and applied as
  ParamValueEvents at their frames: `.clap('Surge XT').auto(sine.range(0, 1).slow(4), { c: 'Global Volume' })`.
  Not on the native output yet.
- Next: plugin GUIs (floating windows; needs CLAP gui plus timer/posix-fd support on Linux).
