use std::collections::HashMap;
use std::sync::mpsc::{ channel, RecvTimeoutError };
use std::thread::sleep;
use std::time::{ Duration, Instant, SystemTime, UNIX_EPOCH };
use midir::MidiOutput;

use tokio::sync::{ mpsc, Mutex };
use serde::Deserialize;

use crate::loggerbridge::Logger;

pub struct MidiMessage {
  pub message: Vec<u8>,
  // when to send it
  pub due: Instant,
  pub requestedport: String,
}

pub struct AsyncInputTransmit {
  pub inner: Mutex<mpsc::Sender<Vec<MidiMessage>>>,
}

// The longest the scheduler waits for new messages when none is queued.
const IDLE_WAIT: Duration = Duration::from_millis(100);

pub fn init(logger: Logger, mut async_input_receiver: mpsc::Receiver<Vec<MidiMessage>>) {
  // Messages are sent from a dedicated thread, not an async task: it sleeps exactly until the next
  // message is due (waiting on the channel, so new messages wake it), instead of polling every
  // millisecond, and blocking there doesn't hold up the async runtime.
  let (sender, receiver) = channel::<Vec<MidiMessage>>();
  tauri::async_runtime::spawn(async move {
    while let Some(messages) = async_input_receiver.recv().await {
      if sender.send(messages).is_err() {
        break;
      }
    }
  });

  std::thread::spawn(move || {
    /* ...........................................................
                        Open Midi Ports
    ............................................................*/
    let midiout = MidiOutput::new("strudel").unwrap();
    let out_ports = midiout.ports();
    let mut port_names = Vec::new();
    if out_ports.len() == 0 {
      logger.log(
        " No MIDI devices found. Connect a device or enable IAC Driver to enable midi.".to_string(),
        "".to_string()
      );
      return;
    }
    sleep(Duration::from_secs(3));
    logger.log(format!("Found {} midi devices!", out_ports.len()), "".to_string());

    let mut output_connections = HashMap::new();
    for i in 0..=out_ports.len().saturating_sub(1) {
      let midiout = MidiOutput::new("strudel").unwrap();
      let ports = midiout.ports();
      let port = ports.get(i).unwrap();
      let port_name = midiout.port_name(port).unwrap();
      logger.log(port_name.clone(), "".to_string());
      let out_con = midiout.connect(port, &port_name).unwrap();
      port_names.insert(i, port_name.clone());
      output_connections.insert(port_name, out_con);
    }
    /* ...........................................................
                        Send queued messages when due
    ............................................................*/
    let mut queue: Vec<MidiMessage> = Vec::new();
    loop {
      let wait = queue
        .iter()
        .map(|m| m.due.saturating_duration_since(Instant::now()))
        .min()
        .unwrap_or(IDLE_WAIT)
        .min(IDLE_WAIT);
      match receiver.recv_timeout(wait) {
        Ok(messages) => queue.extend(messages),
        Err(RecvTimeoutError::Timeout) => {}
        Err(RecvTimeoutError::Disconnected) => return,
      }
      while let Ok(messages) = receiver.try_recv() {
        queue.extend(messages);
      }

      let now = Instant::now();
      queue.retain(|message| {
        if message.due > now {
          return true;
        }
        let mut out_con = output_connections.get_mut(&message.requestedport);

        if out_con.is_none() {
          let key = port_names.iter().find(|port_name| {
            return port_name.contains(&message.requestedport);
          });
          if key.is_some() {
            out_con = output_connections.get_mut(key.unwrap());
          }
        }

        if out_con.is_some() {
          if let Err(err) = (&mut out_con.unwrap()).send(&message.message) {
            logger.log(format!("Midi message send error: {}", err), "error".to_string());
          }
        } else {
          logger.log(format!("failed to find midi device: {}", message.requestedport), "error".to_string());
        }
        return false;
      });
    }
  });
}

#[derive(Deserialize)]
pub struct MessageFromJS {
  message: Vec<u8>,
  // when to send it, as Unix-epoch milliseconds (the page computes it from the audio clock)
  time: f64,
  requestedport: String,
}

// The Instant at which a Unix-epoch time (ms) arrives; times in the past are due now.
fn due_instant(time: f64) -> Instant {
  let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
  let delay_ms = (time - now_ms).max(0.0);
  Instant::now() + Duration::from_secs_f64(delay_ms / 1000.0)
}

#[tauri::command]
pub async fn sendmidi(
  messagesfromjs: Vec<MessageFromJS>,
  state: tauri::State<'_, AsyncInputTransmit>
) -> Result<(), String> {
  let async_proc_input_tx = state.inner.lock().await;
  let messages_to_process: Vec<MidiMessage> = messagesfromjs
    .into_iter()
    .map(|m| MidiMessage {
      due: due_instant(m.time),
      message: m.message,
      requestedport: m.requestedport,
    })
    .collect();

  async_proc_input_tx.send(messages_to_process).await.map_err(|e| e.to_string())
}
