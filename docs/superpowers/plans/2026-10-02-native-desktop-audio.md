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

- The engine plays on the default output device (or the one passed to `engine_start`); there is no
  setting for it in the UI yet.
- Plugins are loaded once and stay loaded for the session; no unloading, no plugin GUIs, no
  parameter automation (`auto`) or effects on plugin audio yet.
- Plugin audio and the webview's audio reach the OS mixer separately; their alignment rests on the
  clock bridge (WebKitGTK's output latency is estimated, not reported).
