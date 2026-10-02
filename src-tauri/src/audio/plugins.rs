// Live CLAP plugin hosting: patterns with .clap(name) send their notes here, and the plugins play on
// a native output (cpal). WebKitGTK can't host plugins, so this lives in the backend.
//
// Threads:
// - each plugin has a host thread, which CLAP calls its main thread: it loads and activates the
//   plugin and then services the plugin's main-thread callback requests.
// - one cpal stream renders all loaded plugins. Activated plugin processors and note events reach
//   its callback through lock-free queues; processors are started there (CLAP wants that on the
//   audio thread).
// Notes carry absolute times (Unix-epoch ms, from the page's audio clock bridge, as for MIDI). The
// callback turns them into sample offsets: a block starts sounding at now + the stream's latency.

use std::collections::HashMap;
use std::ffi::CString;
use std::path::PathBuf;
use std::sync::atomic::{ AtomicBool, AtomicU64, Ordering };
use std::sync::mpsc::{ channel, Sender };
use std::sync::{ Arc, Mutex, OnceLock };
use std::time::{ Duration, Instant, SystemTime, UNIX_EPOCH };

use clack_extensions::audio_ports::{ AudioPortFlags, AudioPortInfoBuffer, PluginAudioPorts };
use clack_extensions::log::{ HostLog, HostLogImpl, LogSeverity };
use clack_extensions::note_ports::{ NoteDialect, NotePortInfoBuffer, PluginNotePorts };
use clack_host::events::event_types::{ MidiEvent, NoteOffEvent, NoteOnEvent };
use clack_host::events::Match;
use clack_host::prelude::*;
use cpal::traits::{ DeviceTrait, HostTrait, StreamTrait };
use rtrb::{ Producer, RingBuffer };
use serde::{ Deserialize, Serialize };

// largest block a plugin is asked to render at once; bigger device blocks are split
const BLOCK: usize = 512;
const CHANNELS: usize = 2;
const CAPTURE_SECONDS: usize = 10;

// ------------------------------------------------------------------ CLAP host side

#[derive(Default)]
struct Shared {
  callback_requested: AtomicBool,
  audio_ports: OnceLock<Option<PluginAudioPorts>>,
  note_ports: OnceLock<Option<PluginNotePorts>>,
}

impl<'a> SharedHandler<'a> for Shared {
  fn initializing(&self, instance: InitializingPluginHandle<'a>) {
    let _ = self.audio_ports.set(instance.get_extension());
    let _ = self.note_ports.set(instance.get_extension());
  }
  fn request_restart(&self) {}
  fn request_process(&self) {}
  fn request_callback(&self) {
    self.callback_requested.store(true, Ordering::SeqCst);
  }
}

impl HostLogImpl for Shared {
  fn log(&self, severity: LogSeverity, message: &str) {
    eprintln!("[plugin {severity}] {message}");
  }
}

struct Host;

impl HostHandlers for Host {
  type Shared<'a> = Shared;
  type MainThread<'a> = ();
  type AudioProcessor<'a> = ();

  fn declare_extensions(builder: &mut HostExtensions<Self>, _shared: &Self::Shared<'_>) {
    builder.register::<HostLog>();
  }
}

struct Layout {
  inputs: Vec<usize>,
  outputs: Vec<usize>,
  main_output: usize,
  note_port: u16,
  use_midi: bool,
}

fn scan_audio_ports(ext: &PluginAudioPorts, handle: &mut PluginMainThreadHandle, is_input: bool) -> Vec<(usize, bool)> {
  let mut buf = AudioPortInfoBuffer::new();
  let mut ports = Vec::new();
  for i in 0..ext.count(handle, is_input) {
    if let Some(info) = ext.get(handle, i, is_input, &mut buf) {
      ports.push((info.channel_count as usize, info.flags.contains(AudioPortFlags::IS_MAIN)));
    }
  }
  ports
}

fn layout(instance: &mut PluginInstance<Host>) -> Result<Layout, String> {
  // both extensions first: the handle borrows the instance
  let audio_ports = instance.access_shared_handler(|s| s.audio_ports.get().copied().flatten());
  let note_ports = instance.access_shared_handler(|s| s.note_ports.get().copied().flatten());
  let mut handle = instance.plugin_handle();
  let (inputs, outputs, main_output) = match audio_ports {
    // without the extension, CLAP's default is one stereo output
    None => (vec![], vec![2], 0),
    Some(ext) => {
      let inputs = scan_audio_ports(&ext, &mut handle, true);
      let outputs = scan_audio_ports(&ext, &mut handle, false);
      if outputs.is_empty() {
        return Err("the plugin has no audio output".to_string());
      }
      let main_output = outputs.iter().position(|&(_, main)| main).unwrap_or(0);
      (inputs.into_iter().map(|(c, _)| c).collect(), outputs.into_iter().map(|(c, _)| c).collect(), main_output)
    }
  };
  let (note_port, use_midi) = match note_ports {
    None => (0, false),
    Some(ext) => {
      if ext.count(&mut handle, true) == 0 {
        return Err("the plugin has no note input".to_string());
      }
      let mut buf = NotePortInfoBuffer::new();
      let info = ext.get(&mut handle, 0, true, &mut buf).ok_or("note port 0 unavailable")?;
      let use_midi = match info.preferred_dialect {
        Some(NoteDialect::Clap) => false,
        Some(NoteDialect::Midi) => true,
        _ if info.supported_dialects.supports(NoteDialect::Clap) => false,
        _ if info.supported_dialects.supports(NoteDialect::Midi) => true,
        _ => return Err("note port 0 takes neither CLAP nor MIDI notes".to_string()),
      };
      (0, use_midi)
    }
  };
  Ok(Layout { inputs, outputs, main_output, note_port, use_midi })
}

// Where plugins are looked for: CLAP_PATH, then the standard per-user and system folders.
fn clap_dirs() -> Vec<PathBuf> {
  let mut dirs: Vec<PathBuf> = std::env::var("CLAP_PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  if let Ok(home) = std::env::var("HOME") {
    dirs.push(PathBuf::from(home).join(".clap"));
  }
  dirs.extend(["/usr/lib/clap", "/usr/lib64/clap", "/usr/local/lib/clap"].map(PathBuf::from));
  dirs
}

pub fn plugin_names() -> Vec<String> {
  let mut names: Vec<String> = clap_dirs()
    .iter()
    .filter_map(|d| std::fs::read_dir(d).ok())
    .flatten()
    .filter_map(|e| e.ok())
    .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".clap")).map(String::from))
    .collect();
  names.sort();
  names.dedup();
  names
}

fn find_plugin(name: &str) -> Result<PathBuf, String> {
  clap_dirs()
    .iter()
    .map(|d| d.join(format!("{}.clap", name)))
    .find(|p| p.exists())
    .ok_or_else(|| format!("no CLAP plugin \"{}\". Found: {}", name, plugin_names().join(", ")))
}

// A plugin activated on its host thread, ready for the audio thread.
struct NewSlot {
  index: usize,
  processor: StoppedPluginAudioProcessor<Host>,
  layout: Layout,
}

// Loads the plugin on a new host thread, which keeps servicing it; returns its activated processor.
fn load_plugin(name: &str, index: usize, sample_rate: f64) -> Result<NewSlot, String> {
  let path = find_plugin(name)?;
  let (ready, loaded) = channel::<Result<NewSlot, String>>();
  std::thread::spawn(move || {
    let result = (|| -> Result<(PluginEntry, PluginInstance<Host>, NewSlot), String> {
      let host_info = HostInfo::new("Strudel", "Strudel", "https://strudel.cc", "0.1.0").map_err(|e| e.to_string())?;
      let path = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
      // SAFETY: loading a plugin runs its native initialisation code, which is what hosting means
      let entry = unsafe { PluginEntry::load(&*path.to_string_lossy()) }.map_err(|e| format!("cannot load {}: {}", path.display(), e))?;
      let factory = entry.get_plugin_factory().ok_or("the bundle has no plugin factory")?;
      let id: CString = factory
        .plugin_descriptors()
        .find(|d| d.features().any(|f| f.to_bytes() == b"instrument"))
        .and_then(|d| d.id().map(|id| id.to_owned()))
        .ok_or("the bundle has no instrument")?;
      let mut instance = PluginInstance::<Host>::new(|_| Shared::default(), |_| (), &entry, &id, &host_info).map_err(|e| e.to_string())?;
      let layout = layout(&mut instance)?;
      let config = PluginAudioConfiguration { sample_rate, min_frames_count: 1, max_frames_count: BLOCK as u32 };
      let processor = instance.activate(|_, _| (), config).map_err(|e| e.to_string())?;
      Ok((entry, instance, NewSlot { index, processor, layout }))
    })();
    match result {
      Err(err) => {
        let _ = ready.send(Err(err));
      }
      Ok((_entry, mut instance, slot)) => {
        let _ = ready.send(Ok(slot));
        // the plugin's main thread, for as long as the app runs
        loop {
          if instance.access_shared_handler(|s| s.callback_requested.swap(false, Ordering::SeqCst)) {
            instance.call_on_main_thread_callback();
          }
          std::thread::sleep(Duration::from_millis(5));
        }
      }
    }
  });
  loaded.recv().map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ audio side

#[derive(Clone, Copy)]
struct NoteEvent {
  plugin: usize,
  due: Instant,
  key: u8,
  velocity: f64,
  on: bool,
}

struct Slot {
  index: usize,
  processor: StartedPluginAudioProcessor<Host>,
  layout: Layout,
  in_bufs: Vec<Vec<Vec<f32>>>,
  out_bufs: Vec<Vec<Vec<f32>>>,
  in_ports: AudioPorts,
  out_ports: AudioPorts,
  events_in: EventBuffer,
  events_out: EventBuffer,
  steady: u64,
}

impl Slot {
  fn new(new: NewSlot) -> Result<Self, String> {
    let processor = new.processor.start_processing().map_err(|e| e.to_string())?;
    let l = &new.layout;
    Ok(Slot {
      index: new.index,
      in_bufs: l.inputs.iter().map(|&c| vec![vec![0.0; BLOCK]; c]).collect(),
      out_bufs: l.outputs.iter().map(|&c| vec![vec![0.0; BLOCK]; c]).collect(),
      in_ports: AudioPorts::with_capacity(l.inputs.iter().sum(), l.inputs.len()),
      out_ports: AudioPorts::with_capacity(l.outputs.iter().sum(), l.outputs.len()),
      events_in: EventBuffer::with_capacity(256),
      events_out: EventBuffer::with_capacity(256),
      processor,
      layout: new.layout,
      steady: 0,
    })
  }

  // Renders n frames with the given (offset, event) notes and adds them into out (interleaved).
  fn render_into(&mut self, out: &mut [f32], n: usize, notes: &[(u32, NoteEvent)]) {
    self.events_in.clear();
    self.events_out.clear();
    let port = self.layout.note_port;
    for (offset, ev) in notes {
      let key = ev.key as u16;
      if self.layout.use_midi {
        let vel = (ev.velocity * 127.0).round().clamp(1.0, 127.0) as u8;
        let data = if ev.on { [0x90, ev.key, vel] } else { [0x80, ev.key, 0] };
        self.events_in.push(&MidiEvent::new(*offset, port, data));
      } else {
        let pckn = Pckn::new(port, 0u16, key, Match::All);
        if ev.on {
          self.events_in.push(&NoteOnEvent::new(*offset, pckn, ev.velocity));
        } else {
          self.events_in.push(&NoteOffEvent::new(*offset, pckn, 0.0));
        }
      }
    }
    for port in self.out_bufs.iter_mut() {
      for ch in port.iter_mut() {
        ch.fill(0.0);
      }
    }
    let inputs = self.in_ports.with_input_buffers(
      self.in_bufs.iter_mut().map(|chans| AudioPortBuffer {
        latency: 0,
        channels: AudioPortBufferType::f32_input_only(chans.iter_mut().map(|b| InputChannel::constant(&mut b[..n]))),
      })
    );
    let mut outputs = self.out_ports.with_output_buffers(
      self.out_bufs.iter_mut().map(|chans| AudioPortBuffer {
        latency: 0,
        channels: AudioPortBufferType::f32_output_only(chans.iter_mut().map(|b| &mut b[..n])),
      })
    );
    let ok = self.processor
      .process(
        &inputs,
        &mut outputs,
        &InputEvents::from_buffer(&self.events_in),
        &mut OutputEvents::from_buffer(&mut self.events_out),
        Some(self.steady),
        None
      )
      .is_ok();
    self.steady += n as u64;
    if !ok {
      return;
    }
    let main = &self.out_bufs[self.layout.main_output];
    for (i, frame) in out.chunks_mut(CHANNELS).take(n).enumerate() {
      for (c, sample) in frame.iter_mut().enumerate() {
        // a mono output goes to both sides
        *sample += main[c.min(main.len() - 1)][i];
      }
    }
  }
}

#[derive(Default)]
struct Stats {
  blocks: AtomicU64,
  frames: AtomicU64,
  notes: AtomicU64,
  late_notes: AtomicU64,
  plugins: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStats {
  running: bool,
  device: Option<String>,
  sample_rate: u32,
  plugins: Vec<String>,
  frames: u64,
  notes: u64,
  late_notes: u64,
}

struct Running {
  sample_rate: u32,
  device: String,
  slots: Producer<NewSlot>,
  events: Producer<NoteEvent>,
  stop: Sender<()>,
  stats: Arc<Stats>,
  capture: Arc<Mutex<Vec<f32>>>,
  capturing: Arc<AtomicBool>,
  plugins: HashMap<String, usize>,
}

#[derive(Default)]
pub struct PluginEngine {
  running: Mutex<Option<Running>>,
}

#[derive(Deserialize)]
pub struct NoteFromJs {
  // Unix-epoch ms
  time: f64,
  duration: f64,
  key: u8,
  velocity: f64,
}

fn epoch_to_instant(time: f64) -> Instant {
  let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
  let delay = (time - now_ms) / 1000.0;
  if delay >= 0.0 {
    Instant::now() + Duration::from_secs_f64(delay)
  } else {
    Instant::now().checked_sub(Duration::from_secs_f64(-delay)).unwrap_or_else(Instant::now)
  }
}

impl PluginEngine {
  pub fn start(&self, device: Option<String>) -> Result<(), String> {
    self.stop();
    let (slots_tx, mut slots_rx) = RingBuffer::<NewSlot>::new(16);
    let (events_tx, mut events_rx) = RingBuffer::<NoteEvent>::new(8192);
    let stats = Arc::new(Stats::default());
    let capture = Arc::new(Mutex::new(Vec::new()));
    let capturing = Arc::new(AtomicBool::new(false));
    let (stop, stopped) = channel::<()>();
    let (ready, started) = channel::<Result<(String, u32), String>>();
    let (t_stats, t_capture, t_capturing) = (Arc::clone(&stats), Arc::clone(&capture), Arc::clone(&capturing));

    std::thread::spawn(move || {
      let result = (|| -> Result<(cpal::Stream, String, u32), String> {
        let host = cpal::default_host();
        let device = match device.as_deref() {
          None | Some("") => host.default_output_device().ok_or("no default output device")?,
          Some(name) => host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == name || n.contains(name)).unwrap_or(false))
            .ok_or_else(|| format!("no output device \"{}\"", name))?,
        };
        let name = device.name().unwrap_or_default();
        let sample_rate = device.default_output_config().map(|c| c.sample_rate().0).unwrap_or(48000);
        let config = cpal::StreamConfig {
          channels: CHANNELS as u16,
          sample_rate: cpal::SampleRate(sample_rate),
          buffer_size: cpal::BufferSize::Default,
        };
        let sr = sample_rate as f64;
        let mut slots: Vec<Slot> = Vec::new();
        let mut pending: Vec<NoteEvent> = Vec::new();
        let mut block_notes: Vec<(u32, NoteEvent)> = Vec::with_capacity(256);
        let stream = device
          .build_output_stream(
            &config,
            move |out: &mut [f32], info: &cpal::OutputCallbackInfo| {
              out.fill(0.0);
              while let Ok(new) = slots_rx.pop() {
                if let Ok(slot) = Slot::new(new) {
                  slots.push(slot);
                }
              }
              while let Ok(ev) = events_rx.pop() {
                pending.push(ev);
              }
              // when the first frame of this block will be heard
              let latency = info.timestamp().playback.duration_since(&info.timestamp().callback).unwrap_or_default();
              let block_start = Instant::now() + latency;
              let frames = out.len() / CHANNELS;
              let mut done = 0;
              while done < frames {
                let n = BLOCK.min(frames - done);
                let start = block_start + Duration::from_secs_f64(done as f64 / sr);
                let end = start + Duration::from_secs_f64(n as f64 / sr);
                for slot in slots.iter_mut() {
                  block_notes.clear();
                  pending.retain(|ev| {
                    if ev.plugin != slot.index || ev.due >= end {
                      return true;
                    }
                    let offset = if ev.due <= start {
                      if ev.on && start.duration_since(ev.due) > Duration::from_millis(5) {
                        t_stats.late_notes.fetch_add(1, Ordering::Relaxed);
                      }
                      0
                    } else {
                      ((ev.due - start).as_secs_f64() * sr) as u32
                    };
                    block_notes.push((offset.min(n as u32 - 1), *ev));
                    false
                  });
                  // CLAP wants events in time order, note-offs first at equal times
                  block_notes.sort_by_key(|(o, ev)| (*o, ev.on));
                  t_stats.notes.fetch_add(block_notes.iter().filter(|(_, e)| e.on).count() as u64, Ordering::Relaxed);
                  slot.render_into(&mut out[done * CHANNELS..(done + n) * CHANNELS], n, &block_notes);
                }
                done += n;
              }
              t_stats.blocks.fetch_add(1, Ordering::Relaxed);
              t_stats.frames.fetch_add(frames as u64, Ordering::Relaxed);
              t_stats.plugins.store(slots.len() as u64, Ordering::Relaxed);
              if t_capturing.load(Ordering::Relaxed) && out.iter().any(|s| *s != 0.0) {
                if let Ok(mut captured) = t_capture.try_lock() {
                  if captured.len() < CAPTURE_SECONDS * sample_rate as usize * CHANNELS {
                    captured.extend_from_slice(out);
                  }
                }
              }
            },
            |err| eprintln!("[plugins] stream error: {}", err),
            None
          )
          .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok((stream, name, sample_rate))
      })();
      match result {
        Ok((stream, name, sample_rate)) => {
          let _ = ready.send(Ok((name, sample_rate)));
          let _ = stopped.recv();
          drop(stream);
        }
        Err(err) => {
          let _ = ready.send(Err(err));
        }
      }
    });

    let (device, sample_rate) = started.recv().map_err(|e| e.to_string())??;
    *self.running.lock().unwrap() = Some(Running {
      sample_rate,
      device,
      slots: slots_tx,
      events: events_tx,
      stop,
      stats,
      capture,
      capturing,
      plugins: HashMap::new(),
    });
    Ok(())
  }

  pub fn stop(&self) {
    if let Some(running) = self.running.lock().unwrap().take() {
      let _ = running.stop.send(());
    }
  }

  // Plays notes on the named plugin, loading it (and starting the engine on the default device)
  // first if needed.
  pub fn play(&self, plugin: &str, notes: Vec<NoteFromJs>) -> Result<(), String> {
    if self.running.lock().unwrap().is_none() {
      self.start(None)?;
    }
    let mut guard = self.running.lock().unwrap();
    let running = guard.as_mut().ok_or("the plugin engine is not running")?;
    let index = match running.plugins.get(plugin) {
      Some(&index) => index,
      None => {
        let index = running.plugins.len();
        let slot = load_plugin(plugin, index, running.sample_rate as f64)?;
        running.slots.push(slot).map_err(|_| "too many plugins".to_string())?;
        running.plugins.insert(plugin.to_string(), index);
        index
      }
    };
    for note in notes {
      let due = epoch_to_instant(note.time);
      let off = epoch_to_instant(note.time + note.duration);
      for ev in [
        NoteEvent { plugin: index, due, key: note.key, velocity: note.velocity, on: true },
        NoteEvent { plugin: index, due: off, key: note.key, velocity: 0.0, on: false },
      ] {
        running.events.push(ev).map_err(|_| "too many queued notes".to_string())?;
      }
    }
    Ok(())
  }

  pub fn stats(&self) -> EngineStats {
    let guard = self.running.lock().unwrap();
    match guard.as_ref() {
      None => EngineStats { running: false, device: None, sample_rate: 0, plugins: vec![], frames: 0, notes: 0, late_notes: 0 },
      Some(r) => {
        let mut plugins: Vec<(&String, &usize)> = r.plugins.iter().collect();
        plugins.sort_by_key(|(_, i)| **i);
        EngineStats {
          running: true,
          device: Some(r.device.clone()),
          sample_rate: r.sample_rate,
          plugins: plugins.into_iter().map(|(n, _)| n.clone()).collect(),
          frames: r.stats.frames.load(Ordering::Relaxed),
          notes: r.stats.notes.load(Ordering::Relaxed),
          late_notes: r.stats.late_notes.load(Ordering::Relaxed),
        }
      }
    }
  }

  // Starts keeping the engine's non-silent output (start = true), or returns and clears it, as
  // little-endian f32 bytes (interleaved stereo).
  pub fn capture(&self, start: bool) -> Vec<u8> {
    let guard = self.running.lock().unwrap();
    let Some(r) = guard.as_ref() else {
      return Vec::new();
    };
    if start {
      r.capture.lock().unwrap().clear();
      r.capturing.store(true, Ordering::Relaxed);
      return Vec::new();
    }
    r.capturing.store(false, Ordering::Relaxed);
    let mut captured = r.capture.lock().unwrap();
    let bytes = captured.iter().flat_map(|s| s.to_le_bytes()).collect();
    captured.clear();
    bytes
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // Needs Surge XT in a CLAP folder; plays on a silent ALSA device (see cue.rs tests).
  #[test]
  fn plays_notes_on_a_plugin() {
    if find_plugin("Surge XT").is_err() || !std::path::Path::new("/usr/share/alsa/alsa.conf").exists() {
      println!("Surge XT or ALSA missing, skipping");
      return;
    }
    std::env::set_var("ALSA_CONFIG_PATH", crate::audio::cue::tests::silent_alsa_config());
    let engine = PluginEngine::default();
    engine.start(Some("strudel_null".to_string())).unwrap();
    engine.capture(true);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
    let notes = [60u8, 64, 67]
      .iter()
      .enumerate()
      .map(|(i, &key)| NoteFromJs { time: now + 200.0 + i as f64 * 200.0, duration: 150.0, key, velocity: 0.8 })
      .collect();
    engine.play("Surge XT", notes).unwrap();
    std::thread::sleep(Duration::from_millis(1200));
    let stats = engine.stats();
    let captured: Vec<f32> = engine
      .capture(false)
      .chunks_exact(4)
      .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
      .collect();
    engine.stop();
    println!("stats: notes {} late {} frames {} plugins {:?}; captured {}", stats.notes, stats.late_notes, stats.frames, stats.plugins, captured.len());
    assert_eq!(stats.plugins, vec!["Surge XT".to_string()]);
    assert_eq!(stats.notes, 3);
    let rms = (captured.iter().map(|s| s * s).sum::<f32>() / captured.len().max(1) as f32).sqrt();
    assert!(rms > 0.001, "rms {}", rms);
  }
}
