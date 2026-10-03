// Native cue (headphone) output: the webview streams its cue mix here as PCM, and a cpal stream plays
// it on the chosen device. The webview can't do this itself: WebKitGTK has no setSinkId, so no
// element of the page can play on a second device.
//
// The page sends interleaved f32 samples in bursts (IPC), and its audio clock and the device's clock
// drift apart. The audio callback keeps a jitter buffer around TARGET_MS: it starts playing once
// that much is buffered, drops a frame when the buffer runs high and repeats one when it runs low,
// and after an underrun buffers up again.

use std::collections::VecDeque;
use std::sync::atomic::{ AtomicBool, AtomicU64, Ordering };
use std::sync::mpsc::{ channel, Sender };
use std::sync::{ Arc, Mutex };

use cpal::traits::{ DeviceTrait, HostTrait, StreamTrait };
use rtrb::{ Producer, RingBuffer };
use serde::Serialize;

const TARGET_MS: f64 = 60.0;
// drift correction starts when the buffer is this far off its target
const BAND_MS: f64 = 30.0;
// what the ring buffer holds at most
const CAPACITY_MS: f64 = 1000.0;
// at most this much played output is kept for cue_capture (blocks that played buffered audio)
const CAPTURE_SECONDS: usize = 10;

// Pacing for devices without a clock. ALSA's `null` device (the test harness's silent "strudel_null")
// takes audio as fast as it is given, so its callback runs flat out: a jitter buffer fed in real time
// runs dry, and nothing behaves as on a real device. With STRUDEL_PACE_AUDIO=1 (set by the test
// harness only), each callback waits until the wall clock has caught up with the frames played so
// far, which makes such a device run in real time. Real devices are never paced.
pub(crate) struct Pacer {
  started: Option<std::time::Instant>,
  frames: u64,
  sample_rate: f64,
}

impl Pacer {
  pub(crate) fn new(sample_rate: f64) -> Option<Self> {
    (std::env::var("STRUDEL_PACE_AUDIO").as_deref() == Ok("1")).then(|| Pacer { started: None, frames: 0, sample_rate })
  }
  // call after a callback has filled `frames` frames
  pub(crate) fn pace(&mut self, frames: usize) {
    let started = *self.started.get_or_insert_with(std::time::Instant::now);
    self.frames += frames as u64;
    let due = started + std::time::Duration::from_secs_f64(self.frames as f64 / self.sample_rate);
    let now = std::time::Instant::now();
    if due > now {
      std::thread::sleep(due - now);
    }
  }
}

#[derive(Default)]
struct Stats {
  underruns: AtomicU64,
  frames_played: AtomicU64,
  frames_dropped: AtomicU64,
  frames_repeated: AtomicU64,
  fill_frames: AtomicU64,
}

struct Running {
  producer: Producer<f32>,
  stop: Sender<()>,
  stats: Arc<Stats>,
  capture: Arc<Mutex<VecDeque<f32>>>,
  capturing: Arc<AtomicBool>,
  sample_rate: u32,
  channels: u16,
  device: String,
}

#[derive(Default)]
pub struct CueState {
  running: Mutex<Option<Running>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueStats {
  running: bool,
  device: Option<String>,
  sample_rate: u32,
  channels: u16,
  underruns: u64,
  frames_played: u64,
  frames_dropped: u64,
  frames_repeated: u64,
  fill_ms: f64,
}

// The playout side of the jitter buffer, run by the audio callback for each block of output.
struct Playout {
  channels: usize,
  target: usize, // frames
  band: usize,   // frames
  buffering: bool,
  last: Vec<f32>,
  played: u64,
  // after a jump: frames left of the crossfade from the frame before it
  fade: usize,
  faded_from: Vec<f32>,
}

// how many frames a jump (shedding a backlog at once) crossfades over
const JUMP_FADE: usize = 32;

impl Playout {
  fn new(channels: usize, target: usize, band: usize) -> Self {
    Playout { channels, target, band, buffering: true, last: vec![0.0; channels], played: 0, fade: 0, faded_from: vec![0.0; channels] }
  }

  // Fills `out` (interleaved) from `consumer`; returns the frames left buffered.
  fn render(&mut self, out: &mut [f32], consumer: &mut rtrb::Consumer<f32>, stats: &Stats) -> usize {
    let ch = self.channels;
    let mut fill = consumer.slots() / ch;
    if self.buffering && fill >= self.target {
      self.buffering = false;
    }
    for frame in out.chunks_mut(ch) {
      if self.buffering {
        frame.fill(0.0);
        continue;
      }
      if fill == 0 {
        stats.underruns.fetch_add(1, Ordering::Relaxed);
        self.buffering = true;
        frame.fill(0.0);
        continue;
      }
      if fill > self.target + 2 * self.band {
        // far too much buffered (a burst): back to the target at once, in one jump that crossfades
        // (skipping a frame per frame instead would play a stretch at double speed)
        let excess = fill - self.target;
        for _ in 0..excess * ch {
          let _ = consumer.pop();
        }
        fill -= excess;
        stats.frames_dropped.fetch_add(excess as u64, Ordering::Relaxed);
        self.fade = JUMP_FADE;
        self.faded_from.copy_from_slice(&self.last);
      } else if fill > self.target + self.band && self.played % 64 == 0 {
        // a little high (the clocks drift): skip one frame now and then
        for _ in 0..ch {
          let _ = consumer.pop();
        }
        fill -= 1;
        stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
        if fill == 0 {
          frame.fill(0.0);
          continue;
        }
      }
      if fill + self.band < self.target && self.played % 64 == 0 {
        // running low: play the previous frame again, without consuming
        frame.copy_from_slice(&self.last);
        stats.frames_repeated.fetch_add(1, Ordering::Relaxed);
      } else {
        for (i, sample) in frame.iter_mut().enumerate() {
          *sample = consumer.pop().unwrap_or(0.0);
          self.last[i] = *sample;
        }
        if self.fade > 0 {
          let w = self.fade as f32 / (JUMP_FADE + 1) as f32;
          for (i, sample) in frame.iter_mut().enumerate() {
            *sample = w * self.faded_from[i] + (1.0 - w) * *sample;
          }
          self.fade -= 1;
        }
        fill -= 1;
      }
      self.played += 1;
      stats.frames_played.fetch_add(1, Ordering::Relaxed);
    }
    stats.fill_frames.store(fill as u64, Ordering::Relaxed);
    fill
  }
}

fn find_device(name: Option<&str>) -> Result<cpal::Device, String> {
  let host = cpal::default_host();
  match name {
    None | Some("") => host.default_output_device().ok_or_else(|| "no default output device".to_string()),
    Some(name) => {
      let devices: Vec<cpal::Device> = host.output_devices().map_err(|e| e.to_string())?.collect();
      let names: Vec<String> = devices.iter().map(|d| d.name().unwrap_or_default()).collect();
      let index = names
        .iter()
        .position(|n| n == name)
        .or_else(|| names.iter().position(|n| n.contains(name)))
        .ok_or_else(|| format!("no output device \"{}\". Available: {}", name, names.join(", ")))?;
      Ok(devices.into_iter().nth(index).unwrap())
    }
  }
}

pub fn devices() -> Result<Vec<String>, String> {
  let host = cpal::default_host();
  let devices = host.output_devices().map_err(|e| e.to_string())?;
  Ok(devices.filter_map(|d| d.name().ok()).collect())
}

impl CueState {
  pub fn start(&self, device: Option<String>, sample_rate: u32, channels: u16) -> Result<(), String> {
    self.stop();
    let ms_frames = |ms: f64| ((ms / 1000.0) * sample_rate as f64) as usize;
    let (producer, mut consumer) = RingBuffer::<f32>::new(ms_frames(CAPACITY_MS) * channels as usize);
    let stats = Arc::new(Stats::default());
    let capture = Arc::new(Mutex::new(VecDeque::new()));
    let capturing = Arc::new(AtomicBool::new(false));
    let (stop, stopped) = channel::<()>();
    let (ready, started) = channel::<Result<String, String>>();

    let target = ms_frames(TARGET_MS);
    let band = ms_frames(BAND_MS);
    let ch = channels as usize;
    let thread_stats = Arc::clone(&stats);
    let thread_capture = Arc::clone(&capture);
    let thread_capturing = Arc::clone(&capturing);

    // cpal streams can't move between threads: this thread owns the stream until stopped
    std::thread::spawn(move || {
      let result = (|| {
        let device = find_device(device.as_deref())?;
        let name = device.name().unwrap_or_default();
        let config = cpal::StreamConfig {
          channels,
          sample_rate: cpal::SampleRate(sample_rate),
          buffer_size: cpal::BufferSize::Default,
        };
        let stats = thread_stats;
        let mut playout = Playout::new(ch, target, band);
        let mut pacer = Pacer::new(sample_rate as f64);
        let stream = device
          .build_output_stream(
            &config,
            move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
              let played_before = playout.played;
              playout.render(out, &mut consumer, &stats);
              // the capture keeps blocks that played buffered audio, not the silence of waiting for it
              if thread_capturing.load(Ordering::Relaxed) && playout.played > played_before {
                // never blocks the audio thread: skipped if the capture is being read
                if let Ok(mut captured) = thread_capture.try_lock() {
                  captured.extend(out.iter().copied());
                  let max = CAPTURE_SECONDS * sample_rate as usize * ch;
                  while captured.len() > max {
                    captured.pop_front();
                  }
                }
              }
              if let Some(pacer) = pacer.as_mut() {
                pacer.pace(out.len() / ch);
              }
            },
            |err| eprintln!("[cue] stream error: {}", err),
            None
          )
          .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok((stream, name))
      })();
      match result {
        Ok((stream, name)) => {
          let _ = ready.send(Ok(name));
          let _ = stopped.recv();
          drop(stream);
        }
        Err(err) => {
          let _ = ready.send(Err(err));
        }
      }
    });

    let name = started.recv().map_err(|e| e.to_string())??;
    *self.running.lock().unwrap() = Some(Running {
      producer,
      stop,
      stats,
      capture,
      capturing,
      sample_rate,
      channels,
      device: name,
    });
    Ok(())
  }

  pub fn stop(&self) {
    if let Some(running) = self.running.lock().unwrap().take() {
      let _ = running.stop.send(());
    }
  }

  // Queues interleaved little-endian f32 samples; what doesn't fit is dropped.
  pub fn write(&self, bytes: &[u8]) {
    if let Some(running) = self.running.lock().unwrap().as_mut() {
      for chunk in bytes.chunks_exact(4) {
        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if running.producer.push(sample).is_err() {
          break;
        }
      }
    }
  }

  pub fn stats(&self) -> CueStats {
    let guard = self.running.lock().unwrap();
    match guard.as_ref() {
      None => CueStats {
        running: false,
        device: None,
        sample_rate: 0,
        channels: 0,
        underruns: 0,
        frames_played: 0,
        frames_dropped: 0,
        frames_repeated: 0,
        fill_ms: 0.0,
      },
      Some(r) => CueStats {
        running: true,
        device: Some(r.device.clone()),
        sample_rate: r.sample_rate,
        channels: r.channels,
        underruns: r.stats.underruns.load(Ordering::Relaxed),
        frames_played: r.stats.frames_played.load(Ordering::Relaxed),
        frames_dropped: r.stats.frames_dropped.load(Ordering::Relaxed),
        frames_repeated: r.stats.frames_repeated.load(Ordering::Relaxed),
        fill_ms: (r.stats.fill_frames.load(Ordering::Relaxed) as f64 * 1000.0) / r.sample_rate as f64,
      },
    }
  }

  // Starts keeping a copy of the samples handed to the device (start = true), or returns and clears
  // what was kept, as little-endian f32 bytes.
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
pub(crate) mod tests {
  use super::*;

  // An ALSA config that adds a device discarding all audio (cpal doesn't list ALSA's own "null"),
  // so tests and probes can play without sound. Set as ALSA_CONFIG_PATH before ALSA is first used.
  pub fn silent_alsa_config() -> std::path::PathBuf {
    // written and set once per process: tests run in parallel, and ALSA reads it while they do
    static CONFIG: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    CONFIG.get_or_init(|| {
      let path = std::env::temp_dir().join(format!("strudel-cue-test-asound-{}.conf", std::process::id()));
      std::fs::write(
        &path,
        "</usr/share/alsa/alsa.conf>\npcm.strudel_null { type null; hint { show on; description \"Strudel test sink (discards audio)\" } }\n",
      )
      .unwrap();
      std::env::set_var("ALSA_CONFIG_PATH", &path);
      path
    })
    .clone()
  }

  #[test]
  fn plays_on_a_device() {
    if !std::path::Path::new("/usr/share/alsa/alsa.conf").exists() {
      println!("no ALSA, skipping");
      return;
    }
    silent_alsa_config();
    let names = devices().unwrap();
    assert!(names.iter().any(|d| d == "strudel_null"), "devices: {:?}", names);
    let state = CueState::default();
    let rate = 48000u32;
    state.start(Some("strudel_null".to_string()), rate, 2).unwrap();
    state.capture(true);
    // 1.5 s of a 440 Hz tone at 0.5, sent in 20 ms chunks at about real time
    let chunk = (rate / 50) as usize;
    let mut n = 0usize;
    // paced to absolute times, like an audio clock (a sleep per chunk would run a few % slow)
    let started = std::time::Instant::now();
    for k in 0..75u64 {
      let bytes: Vec<u8> = (0..chunk)
        .flat_map(|_| {
          let s = 0.5 * ((2.0 * std::f32::consts::PI * 440.0 * n as f32) / rate as f32).sin();
          n += 1;
          [s, s]
        })
        .flat_map(|s| s.to_le_bytes())
        .collect();
      state.write(&bytes);
      let next = started + std::time::Duration::from_millis(20 * (k + 1));
      std::thread::sleep(next.saturating_duration_since(std::time::Instant::now()));
    }
    // stats while the stream is still fed (once the writes stop, it runs dry by design)
    let stats = state.stats();
    println!("played {} dropped {} repeated {} underruns {} fill {:.1} ms", stats.frames_played, stats.frames_dropped, stats.frames_repeated, stats.underruns, stats.fill_ms);
    let captured = state.capture(false);
    state.stop();
    // The null sink has no clock (it pulls blocks as fast as it can), so the timing of the jitter
    // buffer is tested on a simulated clock below. Here: every frame sent was played, and what the
    // device got is the tone, at its level.
    assert!(stats.frames_played >= 72000, "played {} frames", stats.frames_played);
    let left: Vec<f32> = captured
      .chunks_exact(8)
      .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
      .collect();
    let peak = left.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    let sounding = left.iter().filter(|s| s.abs() > 1e-6).count();
    assert!((peak - 0.5).abs() < 0.01, "peak {}", peak);
    assert!(sounding >= 70000, "{} sounding frames of {}", sounding, left.len());
  }

  // A producer at `producer_rate` and a device pulling 256-frame blocks at 48 kHz, for `seconds`:
  // returns the stats and the fill (ms) seen after each block once running.
  fn simulate(producer_rate: f64, seconds: f64) -> (Stats, Vec<f64>) {
    let rate = 48000.0;
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(48000 * 2);
    let stats = Stats::default();
    let mut playout = Playout::new(2, (0.06 * rate) as usize, (0.03 * rate) as usize);
    let mut out = vec![0.0f32; 512];
    let mut produced = 0.0f64;
    let mut fills = Vec::new();
    let blocks = (seconds * rate / 256.0) as usize;
    for block in 0..blocks {
      // the producer sends in 20 ms bursts, on its own clock
      let t = (block as f64 * 256.0) / rate;
      while produced < t * producer_rate + 0.02 * producer_rate {
        for _ in 0..(0.02 * producer_rate) as usize {
          let _ = producer.push(0.25);
          let _ = producer.push(0.25);
        }
        produced += 0.02 * producer_rate;
      }
      let fill = playout.render(&mut out, &mut consumer, &stats);
      if t > 1.0 {
        fills.push((fill as f64 * 1000.0) / rate);
      }
    }
    (stats, fills)
  }

  #[test]
  fn keeps_the_buffer_near_its_target_when_the_clocks_agree() {
    let (stats, fills) = simulate(48000.0, 30.0);
    assert_eq!(stats.underruns.load(Ordering::Relaxed), 0);
    assert!(fills.iter().all(|f| (*f - 60.0).abs() <= 40.0), "fill range {:?}", fills.iter().cloned().fold((f64::MAX, f64::MIN), |(a, b), f| (a.min(f), b.max(f))));
  }

  #[test]
  fn plays_the_samples_in_order() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(4800);
    let stats = Stats::default();
    let mut playout = Playout::new(1, 100, 50);
    let mut played = Vec::new();
    let mut next = 0.0f32;
    for _ in 0..200 {
      for _ in 0..64 {
        producer.push(next).unwrap();
        next += 1.0;
      }
      let mut out = vec![0.0f32; 64];
      playout.render(&mut out, &mut consumer, &stats);
      played.extend(out);
    }
    let sounding: Vec<f32> = played.into_iter().skip_while(|s| *s == 0.0).collect();
    assert!(sounding.windows(2).all(|w| w[1] == w[0] + 1.0), "out of order");
    assert_eq!(stats.underruns.load(Ordering::Relaxed), 0);
  }

  #[test]
  fn sheds_a_burst_in_one_jump() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(48000);
    let stats = Stats::default();
    let mut playout = Playout::new(1, 100, 50);
    let mut next = 1.0f32;
    let mut played = Vec::new();
    // a backlog of 1000 frames arrives at once, then audio at the playing rate
    for _ in 0..1000 {
      producer.push(next).unwrap();
      next += 1.0;
    }
    for _ in 0..50 {
      for _ in 0..64 {
        producer.push(next).unwrap();
        next += 1.0;
      }
      let mut out = vec![0.0f32; 64];
      playout.render(&mut out, &mut consumer, &stats);
      played.extend(out);
    }
    // apart from the crossfade after the jump, every frame follows the one before
    let jumps: Vec<usize> = played.windows(2).enumerate().filter(|(_, w)| w[1] != w[0] + 1.0).map(|(i, _)| i).collect();
    let first = jumps[0];
    assert!(jumps.iter().all(|&i| i <= first + JUMP_FADE), "more than one jump: {:?}", &jumps[..jumps.len().min(40)]);
    let dropped = stats.frames_dropped.load(Ordering::Relaxed);
    assert!(dropped > 800, "dropped {}", dropped);
  }

  #[test]
  fn absorbs_a_producer_running_fast_or_slow() {
    // 1% off is far more than real clock drift (well under 0.01%)
    for rate in [48480.0, 47520.0] {
      let (stats, fills) = simulate(rate, 60.0);
      assert_eq!(stats.underruns.load(Ordering::Relaxed), 0, "underruns at producer rate {}", rate);
      let (lo, hi) = fills.iter().cloned().fold((f64::MAX, f64::MIN), |(a, b), f| (a.min(f), b.max(f)));
      assert!(lo > 0.0 && hi < 120.0, "fill {}..{} ms at producer rate {}", lo, hi, rate);
    }
  }

  #[test]
  fn rebuffers_after_running_dry() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(48000);
    let stats = Stats::default();
    let mut playout = Playout::new(1, 100, 50);
    let mut out = vec![0.0f32; 64];
    for _ in 0..150 {
      producer.push(1.0).unwrap();
    }
    playout.render(&mut out, &mut consumer, &stats);
    assert!(out.iter().all(|s| *s == 1.0), "plays once the target is buffered");
    playout.render(&mut out, &mut consumer, &stats);
    // runs dry in this block (22 frames left, plus one repeated while running low)
    playout.render(&mut out, &mut consumer, &stats);
    assert_eq!(stats.underruns.load(Ordering::Relaxed), 1);
    let ones = out.iter().take_while(|s| **s == 1.0).count();
    assert!((22..=23).contains(&ones) && out[ones..].iter().all(|s| *s == 0.0), "{} frames before running dry", ones);
    // and stays silent until the target is buffered again
    for _ in 0..50 {
      producer.push(1.0).unwrap();
    }
    playout.render(&mut out, &mut consumer, &stats);
    assert!(out.iter().all(|s| *s == 0.0), "silent while buffering up again");
  }
}

