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
- Done 2026-10-02: filters on a plugin's stream. An external channel has a low-, high- and band-pass
  filter (each with a dry path, so a filter that is off is transparent), set by every hap from its
  time on: lpf/hpf/bpf, their q, and their envelopes over the hap's duration (as superdough's voice
  filters). One plugin is one stream, so each note sets the filter for the whole plugin, like a mono
  synth's filter. The amplitude envelope and other per-voice effects stay the plugin's (its own
  parameters, automatable with `.auto()`). Checked by desktop PLUG-1 (part 6, offline renders).
- Done 2026-10-02: exports include plugins. Offline renders (WAV and stems) hand haps whose context
  names an offline renderer to it instead of superdough (`registerOfflineRenderer` in webaudio.mjs).
  The clap renderer loads an instance of each plugin of its own at the export's sample rate
  (`mix_load_instance`, unloaded after with `mix_unload`; the live plugins stay), sends it the notes
  and parameter changes as the render schedules them, and after each chunk renders the chunk's frames
  and plays them through the plugin's channel. The mixer keeps a sample rate per plugin. External
  channels now follow multiChannelOrbits like superdough's voices, so a plugin lands in its orbit's
  stem. Checked by desktop PLUG-1 (part 5): notes within 5 ms of their times (measured 1-3.4 ms;
  Surge XT's onsets), nothing in other stems.
- Done 2026-10-02: plugin parameter automation in the mixer. A plugin's automatable parameters are
  read at load (CLAP params; `clapParams(name)` lists them, Surge XT: 598), and an `.auto()` curve
  whose control names a parameter is sent as timed plain values (`mix_params`) and applied as
  ParamValueEvents at their frames: `.clap('Surge XT').auto(sine.range(0, 1).slow(4), { c: 'Global Volume' })`.
  Not on the native output yet.
- Done 2026-10-02: plugin GUIs. `clapGui(name)` (or `.clap(name, { gui: true })`) opens the plugin's
  own editor: embedded in an X11 window of ours (XWayland on Wayland desktops), or the plugin's
  floating window if that's all it offers; `clapGui(name, false)` or the close button closes it.
  The host implements CLAP's gui, timer-support and posix-fd-support, which plugins on Linux run
  their GUI event loop through.
- All plugins now share one main thread (`strudel-plugins-main`): JUCE-based plugins such as Surge XT
  keep process-wide state that assumes a single main thread, and with a thread per plugin a second
  instance could stall (seen as an intermittent unload timeout). The main thread loads, services
  (callbacks, timers, file descriptors, windows, in one poll) and unloads every plugin.
- Done 2026-10-03: plugin state. CLAP's state extension: `clapState(name)` gives a loaded plugin's
  state (its patch and everything set in its window) as text, `clap1:` and the state deflated in
  base64 (Surge XT: ~7.7 KB), and `.clap(name, { state })` loads it before the plugin's notes (once
  per state, in the mixer, on the native output and in exports). An export's instance starts as the
  live plugin is; a mixer plugin reloaded at a new sample rate, and the native output moved to
  another device, keep their state. Checked by a Rust test and desktop PLUG-1 (part 7).
- Done 2026-10-03: several instances of one plugin. `.clap('Surge XT', { id: 'bass' })` loads an
  instance named by its id (default: the plugin's name), with its own patch, state, parameters,
  window and channel; clapGui, clapState, clapParams and unloadClap take the id. An id switched to
  another plugin replaces the instance (the new one loads first, so a failed swap keeps the old).
  Checked by a Rust test and the new PLUG-2 cell ("Plugin mixing", desktop), which also tracks
  effect plugins and VST3 (still to do, so PLUG-2 fails for now).
- Done 2026-10-03: effect plugins on orbits and the master. `.clapfx(plugin, { id, state })` puts a
  CLAP audio effect after an orbit's own effects (repeat it for a chain); `masterfx(plugin)` puts one
  on the whole mix. superdough has an insert seam (setInsertProvider, like the cue provider): an
  insert takes the orbit's (or master's) audio and gives it back a fixed latency later, and
  everything that plays on that orbit (voices, plugin notes, ducking, automation) is scheduled that
  much early, so it is heard at its time. The desktop insert (packages/desktopbridge/fx.mjs) sends
  512-frame chunks to Rust (`mix_process`, raw samples, chain and start frame in headers), which runs
  the chain, and plays the result 2048 frames (~43-46 ms) after the input; a chunk that comes back
  later than that plays dry and is counted (fxStats). The schedulers deliver haps 100-300 ms ahead,
  so an orbit insert plus a master insert fit. Each effect on each orbit is its own instance (by id,
  or "<plugin> (orbit <n>)"); `auto` reaches its parameters as `{ c: '<name>:<parameter>' }`.
  Chains come from haps; after each evaluation (a new core hook, registerEvalHook) the pattern is
  queried 4 cycles ahead and orbits it no longer sets chains on lose them, and masterfx calls of the
  evaluation become the master chain. Exports with inserts render stems, run each orbit's stem
  through its chain and the sum through the master's, in Rust with instances of their own.
  Measured (desktop PLUG-2): notes after an insert within 0.05 ms of an orbit without one, master
  exactly one insert latency (46.4 ms at 44.1 kHz) after the orbits, no late chunks.
- Done 2026-10-03: VST3 plugins, as instruments and effects, in the mixer and in exports (not on
  the native output yet: an error says so). Hosted with the vst3-host crate (MIT, on the vst3
  bindings); its plugins can't move between threads, so one thread (`strudel-vst3`,
  src-tauri/src/audio/vst3.rs) owns them all: it loads them, renders the blocks the mixer's render
  thread hands it, saves and loads state, and runs their editors' run loops (X11 windows of ours).
  Plugins are looked for in VST3_PATH, ~/.vst3, /usr/lib/vst3, /usr/lib64/vst3, /usr/local/lib/vst3.
  A name means the CLAP if there is one, else the VST3; `{ format: 'vst3' }` (or "vst3:<name>")
  picks the VST3. VST3 parameters are normalized (0-1) for `auto`; states start with "vst3:".
  Checked by a Rust test and PLUG-2 (part 4): notes within 2 ms of a reference, editor drawn,
  effect tail in an export. PLUG-2 now passes.
