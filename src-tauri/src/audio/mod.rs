// Native audio for the desktop app: what the webview (WebKitGTK) can't do itself. A stand-in until
// the VersaTone engine is ready (docs/superpowers/plans/2026-10-02-native-desktop-audio.md).
pub mod cue;
pub mod mixer;
pub mod plugins;

use tauri::ipc::{ InvokeBody, Request, Response };
use tauri::State;

use cue::{ CueState, CueStats };
use mixer::{ MixNote, MixParam, MixerEngine };
use plugins::ParamDesc;
use plugins::{ EngineStats, NoteFromJs, PluginEngine };

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
pub fn clap_play(plugin: String, notes: Vec<NoteFromJs>, engine: State<'_, PluginEngine>) -> Result<(), String> {
  engine.play(&plugin, notes)
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
  let in_mixer = mixer.unload(&plugin)?;
  match engine.unload(&plugin) {
    Ok(()) => Ok(()),
    Err(_) if in_mixer => Ok(()),
    Err(err) => Err(err),
  }
}

// ------------------------------------------------------------------ plugins in the page's mixer

#[tauri::command]
pub fn mix_load(plugin: String, sample_rate: f64, mixer: State<'_, MixerEngine>) -> Result<usize, String> {
  mixer.load(&plugin, sample_rate)
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
