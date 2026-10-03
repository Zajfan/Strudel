// VST3 plugins, hosted with vst3-host. Its plugins can't move between threads, so one thread
// (`strudel-vst3`) owns all of them and does everything with them: loading, rendering the blocks the
// mixer asks for, state, parameters and editors (whose run loops it services between requests).
// The mixer sees a VST3 plugin as a Vst3Slot, which renders like a CLAP Slot (plugins.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{ channel, Receiver, RecvTimeoutError, Sender };
use std::sync::{ Mutex, OnceLock };
use std::time::Duration;

use vst3_host::midi::{ MidiChannel, MidiEvent };
use vst3_host::prelude::*;

use super::plugins::{ ParamDesc, BLOCK, CHANNELS };
use super::x11window::X11Window;

// Where VST3 plugins are looked for: VST3_PATH, then the standard per-user and system folders.
fn vst3_dirs() -> Vec<PathBuf> {
  let mut dirs: Vec<PathBuf> = std::env::var("VST3_PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  if let Ok(home) = std::env::var("HOME") {
    dirs.push(PathBuf::from(home).join(".vst3"));
  }
  dirs.extend(["/usr/lib/vst3", "/usr/lib64/vst3", "/usr/local/lib/vst3"].map(PathBuf::from));
  dirs
}

pub fn vst3_names() -> Vec<String> {
  let mut names: Vec<String> = vst3_dirs()
    .iter()
    .filter_map(|d| std::fs::read_dir(d).ok())
    .flatten()
    .filter_map(|e| e.ok())
    .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".vst3")).map(String::from))
    .collect();
  names.sort();
  names.dedup();
  names
}

pub fn find_vst3(name: &str) -> Option<PathBuf> {
  vst3_dirs().iter().map(|d| d.join(format!("{}.vst3", name))).find(|p| p.exists())
}

// a note for a block: frame offset, key, velocity 0-1, on or off
pub(crate) type BlockNote = (u32, u8, f64, bool);

enum Command {
  Load { path: PathBuf, sample_rate: f64, effect: bool, reply: Sender<Result<(u64, Vec<ParamDesc>), String>> },
  // renders n frames: notes and (offset, id, normalized value) parameter changes, and for an effect
  // its interleaved stereo input; replies with interleaved stereo output
  Block { id: u64, n: usize, notes: Vec<BlockNote>, params: Vec<(u32, u32, f64)>, input: Option<Vec<f32>>, reply: Sender<Vec<f32>> },
  SaveState { id: u64, reply: Sender<Result<Vec<u8>, String>> },
  LoadState { id: u64, data: Vec<u8>, reply: Sender<Result<(), String>> },
  Gui { id: u64, title: String, show: bool, reply: Sender<Result<(), String>> },
  Unload { id: u64 },
}

struct Hosted {
  plugin: Plugin,
  buffers: BusAudioBuffers,
  editor: Option<X11Window>,
}

fn thread() -> Sender<Command> {
  static THREAD: OnceLock<Mutex<Sender<Command>>> = OnceLock::new();
  THREAD
    .get_or_init(|| {
      let (commands, received) = channel();
      std::thread::Builder::new().name("strudel-vst3".to_string()).spawn(move || run(received)).unwrap();
      Mutex::new(commands)
    })
    .lock()
    .unwrap()
    .clone()
}

fn run(commands: Receiver<Command>) {
  let mut host = match Vst3Host::builder().sample_rate(48000.0).block_size(BLOCK).with_process_isolation(false).build() {
    Ok(host) => Some(host),
    Err(err) => {
      eprintln!("[vst3] cannot start the host: {}", err);
      None
    }
  };
  let mut plugins: HashMap<u64, Hosted> = HashMap::new();
  let mut next_id = 0u64;
  loop {
    // with an editor open, its run loop needs servicing ~60 times a second
    let wait = if plugins.values().any(|h| h.editor.is_some()) { Duration::from_millis(16) } else { Duration::from_secs(3600) };
    match commands.recv_timeout(wait) {
      Ok(command) => handle(command, host.as_mut(), &mut plugins, &mut next_id),
      Err(RecvTimeoutError::Timeout) => {}
      Err(RecvTimeoutError::Disconnected) => return,
    }
    for hosted in plugins.values_mut() {
      if hosted.editor.is_some() {
        hosted.plugin.service_run_loop();
        if let Some((width, height)) = hosted.plugin.take_editor_resize_request() {
          if let Ok((w, h)) = hosted.plugin.resize_editor(width, height) {
            hosted.editor.as_ref().unwrap().resize(w as u32, h as u32);
          }
        }
        // closed with its window's close button
        if hosted.editor.as_ref().map_or(false, |w| w.closed()) {
          let _ = hosted.plugin.close_editor();
          hosted.editor = None;
        }
      }
    }
  }
}

fn handle(command: Command, host: Option<&mut Vst3Host>, plugins: &mut HashMap<u64, Hosted>, next_id: &mut u64) {
  match command {
    Command::Load { path, sample_rate, effect, reply } => {
      let result = (|| {
        let host = host.ok_or("the VST3 host did not start")?;
        let mut plugin = host.load_plugin(&path).map_err(|e| format!("cannot load {}: {}", path.display(), e))?;
        plugin.reconfigure(sample_rate, BLOCK).map_err(|e| e.to_string())?;
        let layout = plugin.audio_bus_layout().map_err(|e| e.to_string())?;
        if layout.outputs.is_empty() {
          return Err("the plugin has no audio output".to_string());
        }
        if effect && !layout.inputs.first().map_or(false, |b| b.active && b.channel_count > 0) {
          return Err("the plugin has no audio input".to_string());
        }
        let params = plugin
          .get_parameters()
          .map_err(|e| e.to_string())?
          .into_iter()
          .filter(|p| p.can_automate && !p.is_read_only)
          .map(|p| ParamDesc { id: p.id, name: p.name, module: p.unit, min: 0.0, max: 1.0, default: p.default })
          .collect();
        plugin.start_processing().map_err(|e| e.to_string())?;
        let buffers = plugin.create_bus_audio_buffers(BLOCK).map_err(|e| e.to_string())?;
        let id = *next_id;
        *next_id += 1;
        plugins.insert(id, Hosted { plugin, buffers, editor: None });
        Ok((id, params))
      })();
      let _ = reply.send(result);
    }
    Command::Block { id, n, notes, params, input, reply } => {
      let mut out = vec![0.0f32; n * CHANNELS];
      if let Some(hosted) = plugins.get_mut(&id) {
        render(hosted, n, &notes, &params, input.as_deref(), &mut out);
      }
      let _ = reply.send(out);
    }
    Command::SaveState { id, reply } => {
      let result = match plugins.get(&id) {
        None => Err("the plugin is not loaded".to_string()),
        Some(hosted) => hosted.plugin.save_state().map_err(|e| format!("the plugin did not save its state: {}", e)),
      };
      let _ = reply.send(result);
    }
    Command::LoadState { id, data, reply } => {
      let result = match plugins.get_mut(&id) {
        None => Err("the plugin is not loaded".to_string()),
        Some(hosted) => hosted.plugin.load_state(&data).map_err(|e| format!("the plugin did not take the state: {}", e)),
      };
      let _ = reply.send(result);
    }
    Command::Gui { id, title, show, reply } => {
      let result = (|| {
        let hosted = plugins.get_mut(&id).ok_or("the plugin is not loaded")?;
        if !show {
          if hosted.editor.take().is_some() {
            hosted.plugin.close_editor().map_err(|e| e.to_string())?;
          }
          return Ok(());
        }
        if hosted.editor.is_some() {
          return Ok(());
        }
        if !hosted.plugin.has_editor() {
          return Err("this plugin has no GUI".to_string());
        }
        let (width, height) = hosted.plugin.get_editor_size().unwrap_or((800, 600));
        let window = X11Window::open(&title, width.max(1) as u32, height.max(1) as u32)?;
        hosted.plugin.open_editor(WindowHandle::from_x11(window.id())).map_err(|e| format!("cannot open the editor: {}", e))?;
        hosted.editor = Some(window);
        Ok(())
      })();
      let _ = reply.send(result);
    }
    Command::Unload { id } => {
      if let Some(mut hosted) = plugins.remove(&id) {
        if hosted.editor.take().is_some() {
          let _ = hosted.plugin.close_editor();
        }
        let _ = hosted.plugin.stop_processing();
      }
    }
  }
}

fn render(hosted: &mut Hosted, n: usize, notes: &[BlockNote], params: &[(u32, u32, f64)], input: Option<&[f32]>, out: &mut [f32]) {
  let plugin = &mut hosted.plugin;
  for &(offset, key, velocity, on) in notes {
    let channel = MidiChannel::Ch1;
    let event = if on {
      MidiEvent::NoteOn { channel, note: key.min(127), velocity: (velocity * 127.0).round().clamp(1.0, 127.0) as u8 }
    } else {
      MidiEvent::NoteOff { channel, note: key.min(127), velocity: 0 }
    };
    let _ = plugin.send_midi_event_at(event, offset as i32);
  }
  for &(offset, id, value) in params {
    let _ = plugin.set_parameter_at(id, value.clamp(0.0, 1.0), offset as i32);
  }
  let buffers = &mut hosted.buffers;
  // vst3-host processes as many frames as the buffers hold: exactly n (capacity stays BLOCK)
  for bus in buffers.inputs.iter_mut().chain(buffers.outputs.iter_mut()) {
    for ch in bus.channels.iter_mut() {
      ch.resize(n, 0.0);
    }
  }
  buffers.clear();
  if let (Some(input), Some(bus)) = (input, buffers.inputs.first_mut()) {
    let count = bus.channels.len();
    for (c, ch) in bus.channels.iter_mut().enumerate() {
      for i in 0..n {
        ch[i] = if count == 1 { 0.5 * (input[i * CHANNELS] + input[i * CHANNELS + 1]) } else { input[i * CHANNELS + c.min(CHANNELS - 1)] };
      }
    }
  }
  if plugin.process_bus_audio(buffers).is_err() {
    return;
  }
  let main = &buffers.outputs[0].channels;
  if main.is_empty() {
    return;
  }
  for i in 0..n {
    for c in 0..CHANNELS {
      out[i * CHANNELS + c] += main[c.min(main.len() - 1)][i];
    }
  }
}

// ------------------------------------------------------------------ for the mixer

// A loaded VST3 plugin, rendered on the VST3 thread.
pub(crate) struct Vst3Slot {
  pub(crate) id: u64,
}

impl Vst3Slot {
  pub(crate) fn render_with_notes(&mut self, out: &mut [f32], n: usize, notes: Vec<BlockNote>, params: &[(u32, u32, f64)]) {
    self.block(out, n, notes, params, None);
  }

  pub(crate) fn process_with_params(&mut self, input: &[f32], out: &mut [f32], n: usize, params: &[(u32, u32, f64)]) {
    self.block(out, n, Vec::new(), params, Some(input[..n * CHANNELS].to_vec()));
  }

  fn block(&mut self, out: &mut [f32], n: usize, notes: Vec<BlockNote>, params: &[(u32, u32, f64)], input: Option<Vec<f32>>) {
    let (reply, rendered) = channel();
    let command = Command::Block { id: self.id, n, notes, params: params.to_vec(), input, reply };
    if thread().send(command).is_err() {
      return;
    }
    if let Ok(samples) = rendered.recv_timeout(Duration::from_secs(2)) {
      for (o, s) in out.iter_mut().zip(samples) {
        *o += s;
      }
    }
  }
}

pub(crate) fn load(path: PathBuf, sample_rate: f64, effect: bool) -> Result<(Vst3Slot, Vec<ParamDesc>), String> {
  let (reply, answer) = channel();
  thread().send(Command::Load { path, sample_rate, effect, reply }).map_err(|e| e.to_string())?;
  let (id, params) = answer.recv_timeout(Duration::from_secs(30)).map_err(|e| e.to_string())??;
  Ok((Vst3Slot { id }, params))
}

pub(crate) fn unload(id: u64) {
  let _ = thread().send(Command::Unload { id });
}

pub(crate) fn save_state(id: u64) -> Result<Vec<u8>, String> {
  let (reply, answer) = channel();
  thread().send(Command::SaveState { id, reply }).map_err(|e| e.to_string())?;
  answer.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?
}

pub(crate) fn load_state(id: u64, data: Vec<u8>) -> Result<(), String> {
  let (reply, answer) = channel();
  thread().send(Command::LoadState { id, data, reply }).map_err(|e| e.to_string())?;
  answer.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?
}

pub(crate) fn gui(id: u64, title: &str, show: bool) -> Result<(), String> {
  let (reply, answer) = channel();
  thread().send(Command::Gui { id, title: title.to_string(), show, reply }).map_err(|e| e.to_string())?;
  answer.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?
}
