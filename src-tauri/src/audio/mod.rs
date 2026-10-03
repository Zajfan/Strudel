// Native audio for the desktop app: what the webview (WebKitGTK) can't do itself. A stand-in until
// the VersaTone engine is ready (docs/superpowers/plans/2026-10-02-native-desktop-audio.md).
pub mod cue;
pub mod mixer;
pub mod plugins;
pub mod vst3;
pub mod x11window;

use tauri::ipc::{ InvokeBody, Request, Response };
use tauri::State;

use cue::{ CueState, CueStats };
use mixer::{ MixNote, MixParam, MixerEngine };
use plugins::ParamDesc;
use plugins::{ EngineStats, NoteFromJs, ParamFromJs, PluginEngine };

#[tauri::command]
pub fn cue_devices() -> Result<Vec<String>, String> {
  cue::devices()
}

#[tauri::command]
pub fn cue_start(device: Option<String>, sample_rate: u32, channels: u16, state: State<'_, CueState>) -> Result<(), String> {
  state.start(device, sample_rate, channels)
}

#[tauri::command]
pub fn cue_stop(state: State<'_, CueState>) {
  state.stop();
}

// the body is raw: interleaved little-endian f32 samples
#[tauri::command]
pub fn cue_write(request: Request<'_>, state: State<'_, CueState>) -> Result<(), String> {
  match request.body() {
    InvokeBody::Raw(bytes) => {
      state.write(bytes);
      Ok(())
    }
    _ => Err("cue_write expects raw f32 samples".to_string()),
  }
}

#[tauri::command]
pub fn cue_stats(state: State<'_, CueState>) -> CueStats {
  state.stats()
}

#[tauri::command]
pub fn cue_capture(start: bool, state: State<'_, CueState>) -> Response {
  Response::new(state.capture(start))
}

// ------------------------------------------------------------------ plugins

#[tauri::command]
pub fn clap_plugins() -> Vec<String> {
  plugins::plugin_names()
}

// device: None for the default output
#[tauri::command]
pub fn engine_start(device: Option<String>, engine: State<'_, PluginEngine>) -> Result<(), String> {
  engine.start(device)
}

#[tauri::command]
pub fn clap_play(plugin: String, notes: Vec<NoteFromJs>, instance: Option<String>, engine: State<'_, PluginEngine>) -> Result<(), String> {
  engine.play_as(instance.as_deref().unwrap_or(&plugin), &plugin, notes)
}

#[tauri::command]
pub fn engine_stats(engine: State<'_, PluginEngine>) -> EngineStats {
  engine.stats()
}

#[tauri::command]
pub fn engine_capture(start: bool, engine: State<'_, PluginEngine>) -> Response {
  Response::new(engine.capture(start))
}

// Moves the plugin engine to another output device (None: the default), reloading its plugins.
#[tauri::command]
pub fn engine_set_device(device: Option<String>, engine: State<'_, PluginEngine>) -> Result<(), String> {
  engine.set_device(device)
}

// plugins loaded in either engine (native output, or the page's mixer)
#[tauri::command]
pub fn clap_loaded(engine: State<'_, PluginEngine>, mixer: State<'_, MixerEngine>) -> Vec<String> {
  let mut loaded = engine.loaded();
  loaded.extend(mixer.loaded());
  loaded.sort();
  loaded.dedup();
  loaded
}

#[tauri::command]
pub fn clap_unload(plugin: String, engine: State<'_, PluginEngine>, mixer: State<'_, MixerEngine>) -> Result<(), String> {
  // a plugin that isn't loaded is left as it is
  mixer.unload(&plugin)?;
  if engine.loaded().contains(&plugin) {
    engine.unload(&plugin)?;
  }
  Ok(())
}

// ------------------------------------------------------------------ plugins in the page's mixer

#[tauri::command]
pub fn mix_load(plugin: String, sample_rate: f64, instance: Option<String>, mixer: State<'_, MixerEngine>) -> Result<usize, String> {
  mixer.load_as(instance.as_deref().unwrap_or(&plugin), &plugin, sample_rate)
}

// A loaded plugin's state (patch, GUI tweaks) as text for a pattern, from the mixer or else the native
// output, and loading one into it (both, if loaded in both).
#[tauri::command]
pub fn clap_state(plugin: String, engine: State<'_, PluginEngine>, mixer: State<'_, MixerEngine>) -> Result<String, String> {
  if let Some(index) = mixer.index_of(&plugin) {
    return mixer.state(index);
  }
  let id = engine.host_id(&plugin).ok_or_else(|| format!("\"{}\" is not loaded", plugin))?;
  plugins::save_state(id)
}

#[tauri::command]
pub fn clap_set_state(plugin: String, state: String, engine: State<'_, PluginEngine>, mixer: State<'_, MixerEngine>) -> Result<(), String> {
  let mut found = false;
  if let Some(index) = mixer.index_of(&plugin) {
    mixer.set_state(index, &state)?;
    found = true;
  }
  if let Some(id) = engine.host_id(&plugin) {
    plugins::load_state(id, &state)?;
    found = true;
  }
  if found { Ok(()) } else { Err(format!("\"{}\" is not loaded", plugin)) }
}

#[tauri::command]
pub fn mix_set_state(plugin: usize, state: String, mixer: State<'_, MixerEngine>) -> Result<(), String> {
  mixer.set_state(plugin, &state)
}

// ------------------------------------------------------------------ effect plugins in the mixer

// An effect plugin as the live instance `instance` (default: the plugin's name) for the page's rate.
#[tauri::command]
pub fn mix_load_fx(plugin: String, sample_rate: f64, instance: Option<String>, mixer: State<'_, MixerEngine>) -> Result<usize, String> {
  mixer.load_effect_as(instance.as_deref().unwrap_or(&plugin), &plugin, sample_rate)
}

// a separate instance of an effect, for an export; unloaded with mix_unload
#[tauri::command]
pub fn mix_load_fx_instance(plugin: String, sample_rate: f64, instance: Option<String>, mixer: State<'_, MixerEngine>) -> Result<usize, String> {
  mixer.load_effect_instance_of(instance.as_deref().unwrap_or(&plugin), &plugin, sample_rate)
}

// Runs audio through a chain of effects. The body is raw interleaved stereo little-endian f32;
// headers: x-chain (effect indices, comma-separated, in order) and x-start (the first frame, on the
// page's audio clock, for the effects' parameter changes). Returns the processed audio, same layout.
#[tauri::command]
pub fn mix_process(request: Request<'_>, mixer: State<'_, MixerEngine>) -> Result<Response, String> {
  let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(|v| v.to_string());
  let chain: Vec<usize> = header("x-chain")
    .ok_or("mix_process: no x-chain header")?
    .split(',')
    .filter(|s| !s.is_empty())
    .map(|s| s.trim().parse::<usize>().map_err(|e| e.to_string()))
    .collect::<Result<_, _>>()?;
  let start: i64 = header("x-start").ok_or("mix_process: no x-start header")?.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
  let InvokeBody::Raw(bytes) = request.body() else {
    return Err("mix_process expects raw f32 samples".to_string());
  };
  let input: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
  Ok(Response::new(mixer.process(chain, start, input)?))
}

// a separate instance of a plugin, for an export (offline render); unloaded with mix_unload
#[tauri::command]
pub fn mix_load_instance(plugin: String, sample_rate: f64, instance: Option<String>, mixer: State<'_, MixerEngine>) -> Result<usize, String> {
  mixer.load_instance_of(instance.as_deref().unwrap_or(&plugin), &plugin, sample_rate)
}

#[tauri::command]
pub fn mix_unload(plugin: usize, mixer: State<'_, MixerEngine>) -> Result<(), String> {
  mixer.unload_index(plugin)
}

#[tauri::command]
pub fn mix_notes(plugin: usize, notes: Vec<MixNote>, mixer: State<'_, MixerEngine>) -> Result<(), String> {
  mixer.notes(plugin, notes)
}

// frames [start, start + frames) of the page's audio clock, as interleaved stereo f32
#[tauri::command]
pub fn mix_render(plugin: usize, start: i64, frames: usize, mixer: State<'_, MixerEngine>) -> Result<Response, String> {
  Ok(Response::new(mixer.render(plugin, start, frames)?))
}

#[tauri::command]
pub fn mix_param_list(plugin: usize, mixer: State<'_, MixerEngine>) -> Result<Vec<ParamDesc>, String> {
  mixer.param_list(plugin)
}

#[tauri::command]
pub fn mix_params(plugin: usize, params: Vec<MixParam>, mixer: State<'_, MixerEngine>) -> Result<(), String> {
  mixer.params(plugin, params)
}

// Shows or hides a plugin's own GUI (in its own window); the plugin must be loaded (played once).
#[tauri::command]
pub fn clap_gui(plugin: String, show: bool, engine: State<'_, PluginEngine>, mixer: State<'_, MixerEngine>) -> Result<(), String> {
  if mixer.gui(&plugin, show)? || engine.gui(&plugin, show)? {
    Ok(())
  } else {
    Err(format!("\"{}\" is not loaded: play a note on it first", plugin))
  }
}

// A loaded plugin's automatable parameters, by name, from whichever engine has it.
#[tauri::command]
pub fn clap_param_list(plugin: String, engine: State<'_, PluginEngine>, mixer: State<'_, MixerEngine>) -> Result<Vec<ParamDesc>, String> {
  if let Some(index) = mixer.index_of(&plugin) {
    return mixer.param_list(index);
  }
  engine.param_list(&plugin).ok_or_else(|| format!("\"{}\" is not loaded: play a note on it first", plugin))
}

// parameter changes for a plugin on the native output, at Unix-epoch times (ms)
#[tauri::command]
pub fn clap_params(plugin: String, params: Vec<ParamFromJs>, engine: State<'_, PluginEngine>) -> Result<(), String> {
  engine.params(&plugin, params)
}
