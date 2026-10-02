use std::sync::Arc;
use tauri::{Emitter, WebviewWindow};

#[derive(Clone, serde::Serialize)]
pub struct LoggerPayload {
  pub message: String,
  pub message_type: String,
}

#[derive(Clone)]
pub struct Logger {
  pub window: Arc<WebviewWindow>,
}

impl Logger {
  pub fn log(&self, message: String, message_type: String) {
    println!("{}", message);
    let _ = self.window.emit("log-event", LoggerPayload { message, message_type });
  }
}
