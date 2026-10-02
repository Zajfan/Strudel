// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod midibridge;
mod oscbridge;
mod loggerbridge;
use std::sync::Arc;

use loggerbridge::Logger;
use tauri::Manager;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
// the payload type must implement `Serialize` and `Clone`.
#[derive(Clone, serde::Serialize)]
struct Payload {
  message: String,
  message_type: String,
}
fn main() {
  let (async_input_transmitter_midi, async_input_receiver_midi) = mpsc::channel(1);
  let (async_input_transmitter_osc, async_input_receiver_osc) = mpsc::channel(1);
  let (async_output_transmitter_osc, async_output_receiver_osc) = mpsc::channel(1);
  tauri::Builder
    ::default()
    .manage(midibridge::AsyncInputTransmit {
      inner: Mutex::new(async_input_transmitter_midi),
    })
    .manage(oscbridge::AsyncInputTransmit {
      inner: Mutex::new(async_input_transmitter_osc),
    })
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .manage(audio::cue::CueState::default())
    .manage(audio::plugins::PluginEngine::default())
    .manage(audio::mixer::MixerEngine::default())
    .invoke_handler(
      tauri::generate_handler![
        midibridge::sendmidi,
        oscbridge::sendosc,
        audio::cue_devices,
        audio::cue_start,
        audio::cue_stop,
        audio::cue_write,
        audio::cue_stats,
        audio::cue_capture,
        audio::clap_plugins,
        audio::engine_start,
        audio::clap_play,
        audio::engine_stats,
        audio::engine_capture,
        audio::engine_set_device,
        audio::clap_loaded,
        audio::clap_unload,
        audio::mix_load,
        audio::mix_notes,
        audio::mix_render
      ]
    )
    .setup(|app| {
      let window = Arc::new(app.get_webview_window("main").unwrap());
      let logger = Logger { window };
      midibridge::init(logger.clone(), async_input_receiver_midi);
      oscbridge::init(logger, async_input_receiver_osc, async_output_receiver_osc, async_output_transmitter_osc);
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
