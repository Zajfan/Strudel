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
// WebKitGTK frees the native memory behind Web Audio nodes only when its garbage collector runs,
// which JS memory pressure alone rarely triggers in an audio app: with many notes playing, the web
// process grew steadily (SOAK-1). A memory limit makes WebKit relieve memory (collect, purge caches)
// as the process approaches it. Applies to web processes started afterwards, so it is set first.
#[cfg(target_os = "linux")]
fn set_webkit_memory_limit(megabytes: u32) {
  use std::ffi::c_void;
  extern "C" {
    fn webkit_memory_pressure_settings_new() -> *mut c_void;
    fn webkit_memory_pressure_settings_set_memory_limit(settings: *mut c_void, megabytes: u32);
    fn webkit_memory_pressure_settings_free(settings: *mut c_void);
    fn webkit_website_data_manager_set_memory_pressure_settings(settings: *mut c_void);
  }
  // SAFETY: plain calls into the WebKitGTK library the webview links; the settings are copied by
  // WebKit and freed here
  unsafe {
    let settings = webkit_memory_pressure_settings_new();
    webkit_memory_pressure_settings_set_memory_limit(settings, megabytes);
    webkit_website_data_manager_set_memory_pressure_settings(settings);
    webkit_memory_pressure_settings_free(settings);
  }
}

fn main() {
  #[cfg(target_os = "linux")]
  set_webkit_memory_limit(std::env::var("STRUDEL_WEBKIT_MEMORY_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(1024));
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
    // effect plugins' audio, from a Web Worker (which can't use invoke): see audio::fx_protocol
    .register_asynchronous_uri_scheme_protocol("strudelfx", audio::fx_protocol)
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
        audio::mix_stats,
        audio::mix_load_fx,
        audio::mix_load_fx_instance,
        audio::mix_process,
        audio::mix_set_state,
        audio::clap_state,
        audio::clap_set_state,
        audio::mix_load_instance,
        audio::mix_unload,
        audio::mix_notes,
        audio::mix_render,
        audio::mix_param_list,
        audio::mix_params,
        audio::clap_gui,
        audio::clap_param_list,
        audio::clap_params
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
