// Plugins rendered for the page's mixer: the page plays each plugin as a stream through superdough
// (effects, ducking, stems, cue) and pulls its audio from here as it needs it. Notes and render
// requests are in frames of the page's audio clock, so plugin audio lines up exactly with the rest.
// One render thread is the plugins' audio thread (CLAP); each plugin also has its host thread
// (plugins.rs). The page renders a little ahead (its notes come ~100 ms early), so latency here only
// needs to stay below that.

use std::collections::HashMap;
use std::sync::mpsc::{ channel, Receiver, Sender };
use std::sync::Mutex;
use std::time::{ Duration, Instant };

use serde::Deserialize;

use super::plugins::{ host_gui, load_plugin, wait_unloaded, Loaded, NewSlot, NoteEvent, ParamDesc, Slot, BLOCK, CHANNELS };

#[derive(Deserialize)]
pub struct MixNote {
  // seconds on the page's audio clock (AudioContext time)
  time: f64,
  duration: f64,
  key: u8,
  velocity: f64,
}

#[derive(Deserialize)]
pub struct MixParam {
  // seconds on the page's audio clock
  time: f64,
  // the parameter's id (see mix_param_list) and its plain value
  id: u32,
  value: f64,
}

#[derive(Clone, Copy)]
struct FrameParam {
  frame: i64,
  id: u32,
  value: f64,
}

#[derive(Clone, Copy)]
struct FrameNote {
  frame: i64,
  key: u8,
  velocity: f64,
  on: bool,
}

enum Command {
  Add(NewSlot),
  Notes(usize, Vec<FrameNote>),
  Params(usize, Vec<FrameParam>),
  Render { plugin: usize, start: i64, frames: usize, reply: Sender<Vec<u8>> },
  Remove(usize),
}

struct Inner {
  commands: Sender<Command>,
  // the live plugins by name (one instance each); export renders load their own instances, by index only
  plugins: HashMap<String, usize>,
  // per plugin index: the sample rate it was loaded for (the page's, or an export's)
  rates: HashMap<usize, f64>,
  params: HashMap<usize, Vec<ParamDesc>>,
  // per plugin index: its signal for having unloaded, and its id on the main thread
  unloaded: HashMap<usize, Receiver<()>>,
  host_ids: HashMap<usize, u64>,
  next_index: usize,
}

#[derive(Default)]
pub struct MixerEngine {
  inner: Mutex<Option<Inner>>,
}

// The render thread: plugins with their pending notes, rendering on request.
fn render_thread(commands: Receiver<Command>) {
  // per plugin: the slot, its pending notes and its pending parameter changes
  let mut slots: HashMap<usize, (Slot, Vec<FrameNote>, Vec<FrameParam>)> = HashMap::new();
  let mut block_notes: Vec<(u32, NoteEvent)> = Vec::with_capacity(256);
  let mut block_params: Vec<(u32, u32, f64)> = Vec::with_capacity(256);
  while let Ok(command) = commands.recv() {
    match command {
      Command::Add(new) => {
        let index = new.index;
        if let Ok(slot) = Slot::new(new) {
          slots.insert(index, (slot, Vec::new(), Vec::new()));
        }
      }
      Command::Notes(plugin, notes) => {
        if let Some((_, pending, _)) = slots.get_mut(&plugin) {
          pending.extend(notes);
        }
      }
      Command::Params(plugin, params) => {
        if let Some((_, _, pending)) = slots.get_mut(&plugin) {
          pending.extend(params);
        }
      }
      Command::Render { plugin, start, frames, reply } => {
        let mut out = vec![0.0f32; frames * CHANNELS];
        if let Some((slot, pending, pending_params)) = slots.get_mut(&plugin) {
          let mut done = 0usize;
          while done < frames {
            let n = BLOCK.min(frames - done);
            let from = start + done as i64;
            let to = from + n as i64;
            block_notes.clear();
            pending.retain(|note| {
              if note.frame >= to {
                return true;
              }
              // a note for an earlier frame is played at once (it came too late to be exact)
              let offset = (note.frame - from).max(0) as u32;
              let event = NoteEvent { plugin, due: Instant::now(), key: note.key, velocity: note.velocity, on: note.on };
              block_notes.push((offset, event));
              false
            });
            block_notes.sort_by_key(|(o, ev)| (*o, ev.on));
            block_params.clear();
            pending_params.retain(|param| {
              if param.frame >= to {
                return true;
              }
              block_params.push(((param.frame - from).max(0) as u32, param.id, param.value));
              false
            });
            block_params.sort_by_key(|(o, _, _)| *o);
            slot.render_with_params(&mut out[done * CHANNELS..(done + n) * CHANNELS], n, &block_notes, &block_params);
            done += n;
          }
        }
        let _ = reply.send(out.iter().flat_map(|s| s.to_le_bytes()).collect());
      }
      Command::Remove(plugin) => {
        if let Some((slot, _, _)) = slots.remove(&plugin) {
          slot.retire();
        }
      }
    }
  }
  // the engine is gone: hand every plugin back for deactivation
  for (_, (slot, _, _)) in slots.drain() {
    slot.retire();
  }
}

impl MixerEngine {
  // Loads a plugin for the given sample rate (the page's) and returns its index. If it was loaded
  // for another rate (a new AudioContext), it is reloaded at the new one.
  pub fn load(&self, plugin: &str, sample_rate: f64) -> Result<usize, String> {
    let loaded = {
      let guard = self.inner.lock().unwrap();
      guard.as_ref().and_then(|inner| inner.plugins.get(plugin).map(|&i| (i, inner.rates.get(&i) == Some(&sample_rate))))
    };
    match loaded {
      Some((index, true)) => return Ok(index),
      Some((index, false)) => {
        self.unload_index(index)?;
      }
      None => {}
    }
    let index = self.load_instance(plugin, sample_rate)?;
    self.inner.lock().unwrap().as_mut().ok_or("no plugins loaded")?.plugins.insert(plugin.to_string(), index);
    Ok(index)
  }

  // Loads a new instance of a plugin, apart from the live one (for an export), and returns its index.
  pub fn load_instance(&self, plugin: &str, sample_rate: f64) -> Result<usize, String> {
    let mut guard = self.inner.lock().unwrap();
    let inner = guard.get_or_insert_with(|| {
      let (commands, receiver) = channel();
      std::thread::spawn(move || render_thread(receiver));
      Inner {
        commands,
        plugins: HashMap::new(),
        rates: HashMap::new(),
        params: HashMap::new(),
        unloaded: HashMap::new(),
        host_ids: HashMap::new(),
        next_index: 0,
      }
    });
    let index = inner.next_index;
    inner.next_index += 1;
    let Loaded { slot, unloaded, id } = load_plugin(plugin, index, sample_rate)?;
    inner.host_ids.insert(index, id);
    inner.unloaded.insert(index, unloaded);
    inner.rates.insert(index, sample_rate);
    inner.params.insert(index, slot.layout.params.clone());
    inner.commands.send(Command::Add(slot)).map_err(|e| e.to_string())?;
    Ok(index)
  }

  // the sample rate a loaded plugin renders at
  fn rate(&self, plugin: usize) -> Result<(Sender<Command>, f64), String> {
    let guard = self.inner.lock().unwrap();
    let inner = guard.as_ref().ok_or("no plugins loaded")?;
    let rate = *inner.rates.get(&plugin).ok_or("no such plugin")?;
    Ok((inner.commands.clone(), rate))
  }

  pub fn notes(&self, plugin: usize, notes: Vec<MixNote>) -> Result<(), String> {
    let (commands, sr) = self.rate(plugin)?;
    let mut frames = Vec::with_capacity(notes.len() * 2);
    for note in notes {
      let on = (note.time * sr).round() as i64;
      let off = ((note.time + note.duration) * sr).round() as i64;
      frames.push(FrameNote { frame: on, key: note.key, velocity: note.velocity, on: true });
      frames.push(FrameNote { frame: off.max(on + 1), key: note.key, velocity: 0.0, on: false });
    }
    commands.send(Command::Notes(plugin, frames)).map_err(|e| e.to_string())
  }

  // Shows or hides a loaded plugin's GUI; Ok(false) if it isn't loaded here.
  pub fn gui(&self, plugin: &str, show: bool) -> Result<bool, String> {
    let id = {
      let guard = self.inner.lock().unwrap();
      let Some(inner) = guard.as_ref() else {
        return Ok(false);
      };
      let Some(index) = inner.plugins.get(plugin) else {
        return Ok(false);
      };
      *inner.host_ids.get(index).ok_or("no id for this plugin")?
    };
    host_gui(id, &format!("{} - Strudel", plugin), show)?;
    Ok(true)
  }

  // a loaded plugin's index here, by name
  pub fn index_of(&self, plugin: &str) -> Option<usize> {
    self.inner.lock().unwrap().as_ref().and_then(|inner| inner.plugins.get(plugin).copied())
  }

  // the parameters a pattern can automate on a loaded plugin
  pub fn param_list(&self, plugin: usize) -> Result<Vec<ParamDesc>, String> {
    let guard = self.inner.lock().unwrap();
    let inner = guard.as_ref().ok_or("no plugins loaded")?;
    inner.params.get(&plugin).cloned().ok_or_else(|| "no such plugin".to_string())
  }

  pub fn params(&self, plugin: usize, params: Vec<MixParam>) -> Result<(), String> {
    let (commands, sr) = self.rate(plugin)?;
    let frames = params
      .into_iter()
      .map(|p| FrameParam { frame: (p.time * sr).round() as i64, id: p.id, value: p.value })
      .collect();
    commands.send(Command::Params(plugin, frames)).map_err(|e| e.to_string())
  }

  // Interleaved stereo little-endian f32 for frames [start, start + frames) of the page's clock.
  pub fn render(&self, plugin: usize, start: i64, frames: usize) -> Result<Vec<u8>, String> {
    let (reply, rendered) = channel();
    {
      let guard = self.inner.lock().unwrap();
      let inner = guard.as_ref().ok_or("no plugins loaded")?;
      inner.commands.send(Command::Render { plugin, start, frames, reply }).map_err(|e| e.to_string())?;
    }
    rendered.recv_timeout(Duration::from_secs(2)).map_err(|e| e.to_string())
  }

  pub fn loaded(&self) -> Vec<String> {
    let guard = self.inner.lock().unwrap();
    let Some(inner) = guard.as_ref() else {
      return Vec::new();
    };
    let mut plugins: Vec<(&String, &usize)> = inner.plugins.iter().collect();
    plugins.sort_by_key(|(_, i)| **i);
    plugins.into_iter().map(|(n, _)| n.clone()).collect()
  }

  // Unloads a live plugin; Ok(false) if it wasn't loaded here.
  pub fn unload(&self, plugin: &str) -> Result<bool, String> {
    let Some(index) = self.index_of(plugin) else {
      return Ok(false);
    };
    self.unload_index(index)?;
    Ok(true)
  }

  // Unloads a plugin instance by index (a live plugin or an export's).
  pub fn unload_index(&self, index: usize) -> Result<(), String> {
    let unloaded = {
      let mut guard = self.inner.lock().unwrap();
      let inner = guard.as_mut().ok_or("no plugins loaded")?;
      if inner.rates.remove(&index).is_none() {
        return Err("no such plugin".to_string());
      }
      inner.plugins.retain(|_, i| *i != index);
      inner.params.remove(&index);
      inner.host_ids.remove(&index);
      inner.commands.send(Command::Remove(index)).map_err(|e| e.to_string())?;
      inner.unloaded.remove(&index)
    };
    if let Some(unloaded) = unloaded {
      wait_unloaded(&unloaded, &format!("plugin {}", index))?;
    }
    Ok(())
  }

  pub fn reset(&self) {
    let indices: Vec<usize> = self.inner.lock().unwrap().as_ref().map_or(Vec::new(), |inner| inner.rates.keys().copied().collect());
    for index in indices {
      let _ = self.unload_index(index);
    }
    *self.inner.lock().unwrap() = None;
  }
}
#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn renders_notes_at_their_frames_on_the_page_clock() {
    if super::super::plugins::plugin_names().iter().all(|n| n != "Surge XT") {
      println!("Surge XT missing, skipping");
      return;
    }
    let sr = 44100.0;
    let mixer = MixerEngine::default();
    let index = mixer.load("Surge XT", sr).unwrap();
    mixer
      .notes(index, vec![
        MixNote { time: 0.1, duration: 0.2, key: 60, velocity: 0.8 },
        MixNote { time: 0.5, duration: 0.2, key: 67, velocity: 0.8 },
      ])
      .unwrap();
    // pulled in chunks, as the page's player does
    let mut left = Vec::new();
    for chunk in 0..43 {
      let bytes = mixer.render(index, chunk * 1024, 1024).unwrap();
      left.extend(bytes.chunks_exact(8).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
    }
    let first = left.iter().position(|s| s.abs() > 1e-4).expect("no sound");
    println!("first sound at frame {} (note at {})", first, (0.1 * sr) as usize);
    // The note goes in at its exact frame. The plugin adds its own spread: Surge XT starts notes on
    // 16-frame internal blocks, and its attack decides when the first sample passes 1e-4 (measured
    // -24..+34 frames), so allow 64 frames (1.5 ms) either way.
    assert!((first as i64 - 4410).abs() <= 64, "first sound at frame {}", first);
    // (plugins may output tiny values while idle; "sound" means above 1e-4, as for the onset)
    assert!(left[..4410 - 64].iter().all(|s| s.abs() <= 1e-4), "sound well before the note");
    mixer.reset();
    assert!(mixer.loaded().is_empty());
  }

  #[test]
  fn automates_a_plugin_parameter_at_its_frame() {
    if super::super::plugins::plugin_names().iter().all(|n| n != "Surge XT") {
      println!("Surge XT missing, skipping");
      return;
    }
    let sr = 44100.0;
    let mixer = MixerEngine::default();
    let index = mixer.load("Surge XT", sr).unwrap();
    let params = mixer.param_list(index).unwrap();
    println!("{} parameters; volume-like: {:?}", params.len(), params.iter().filter(|p| p.name.to_lowercase().contains("volume")).take(5).map(|p| (&p.name, &p.module, p.min, p.max)).collect::<Vec<_>>());
    let volume = params
      .iter()
      .find(|p| p.name.eq_ignore_ascii_case("Global Volume") || p.name.eq_ignore_ascii_case("Volume"))
      .expect("no volume parameter");
    // a held note; the volume drops to its minimum at 0.5 s
    mixer.notes(index, vec![MixNote { time: 0.05, duration: 0.95, key: 60, velocity: 0.8 }]).unwrap();
    mixer.params(index, vec![MixParam { time: 0.5, id: volume.id, value: volume.min }]).unwrap();
    let mut left = Vec::new();
    for chunk in 0..43 {
      let bytes = mixer.render(index, chunk * 1024, 1024).unwrap();
      left.extend(bytes.chunks_exact(8).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
    }
    let rms = |from: f64, to: f64| {
      let part = &left[(from * sr) as usize..(to * sr) as usize];
      (part.iter().map(|s| s * s).sum::<f32>() / part.len() as f32).sqrt()
    };
    let (before, after) = (rms(0.3, 0.48), rms(0.55, 0.9));
    println!("rms before {} after {} ({})", before, after, volume.name);
    mixer.reset();
    assert!(before > 0.01, "no sound before the change");
    assert!(after < before / 10.0, "the volume change didn't apply");
  }

  #[test]
  fn renders_an_export_instance_without_disturbing_the_live_plugin() {
    if super::super::plugins::plugin_names().iter().all(|n| n != "Surge XT") {
      println!("Surge XT missing, skipping");
      return;
    }
    let mixer = MixerEngine::default();
    let live = mixer.load("Surge XT", 44100.0).unwrap();
    // an export at another rate: its own instance, the live one stays
    let export = mixer.load_instance("Surge XT", 48000.0).unwrap();
    assert_ne!(live, export);
    assert_eq!(mixer.load("Surge XT", 44100.0).unwrap(), live);
    mixer.notes(export, vec![MixNote { time: 0.1, duration: 0.2, key: 60, velocity: 0.8 }]).unwrap();
    let bytes = mixer.render(export, 0, 9600).unwrap();
    let left: Vec<f32> = bytes.chunks_exact(8).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let first = left.iter().position(|s| s.abs() > 1e-4).expect("no sound");
    // at 48 kHz, 0.1 s is frame 4800; Surge XT's onset spreads more at this rate (measured +33..+89
    // frames, with a sharp attack), so allow 2 ms
    assert!((first as i64 - 4800).abs() <= 96, "first sound at frame {}", first);
    mixer.unload_index(export).unwrap();
    assert_eq!(mixer.loaded(), vec!["Surge XT".to_string()]);
    // a new page rate reloads the live plugin
    let reloaded = mixer.load("Surge XT", 48000.0).unwrap();
    assert_ne!(reloaded, live);
    assert_eq!(mixer.loaded(), vec!["Surge XT".to_string()]);
    mixer.reset();
    assert!(mixer.loaded().is_empty());
  }
}
