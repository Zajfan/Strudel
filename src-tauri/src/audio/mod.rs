// Native audio for the desktop app: what the webview (WebKitGTK) can't do itself. A stand-in until
// the VersaTone engine is ready (docs/superpowers/plans/2026-10-02-native-desktop-audio.md).
pub mod cue;

use tauri::ipc::{ InvokeBody, Request, Response };
use tauri::State;

use cue::{ CueState, CueStats };

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
