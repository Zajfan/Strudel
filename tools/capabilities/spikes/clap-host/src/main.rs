//! PLUG-1 spike: `clap-host <plugin.clap> <out.json> [events.json]`.
//!
//! Loads a CLAP bundle with `clack-host`, instantiates its first instrument with 512-frame
//! blocks and renders note events. Without `events.json` it plays key 60 (note-on at frame 0,
//! note-off at frame 24000) over 48000 frames at 48 kHz. With it, it renders
//! `{ sampleRate, frames, events: [{ frame, key, velocity, type: "on"|"off" }] }`, delivering
//! each event at its exact frame (split across 512-frame blocks).
//! Writes `{ pluginId, pluginName, frames, rms, peak, eventsDelivered }` as JSON.
//! Any failure exits non-zero with the error on stderr. Throwaway tooling; no Tauri.

use clack_extensions::audio_ports::{AudioPortFlags, AudioPortInfoBuffer, PluginAudioPorts};
use clack_extensions::log::{HostLog, HostLogImpl, LogSeverity};
use clack_extensions::note_ports::{NoteDialect, NotePortInfoBuffer, PluginNotePorts};
use clack_host::events::event_types::{MidiEvent, NoteOffEvent, NoteOnEvent};
use clack_host::events::Match;
use clack_host::prelude::*;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

const BLOCK: usize = 512;

#[derive(Clone, Copy, Debug)]
struct NoteEv {
    frame: usize,
    key: u16,
    velocity: f64,
    on: bool,
}

struct Score {
    sample_rate: f64,
    frames: usize,
    /// Sorted by frame; at equal frames note-offs come before note-ons.
    events: Vec<NoteEv>,
}

impl Score {
    fn fixed_note() -> Self {
        Score {
            sample_rate: 48_000.0,
            frames: 48_000,
            events: vec![
                NoteEv { frame: 0, key: 60, velocity: 1.0, on: true },
                NoteEv { frame: 24_000, key: 60, velocity: 1.0, on: false },
            ],
        }
    }

    fn from_json(path: &str) -> Result<Self, Error> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
        let sample_rate = v["sampleRate"].as_f64().ok_or("events.json: sampleRate missing")?;
        if !(sample_rate > 0.0) {
            return Err("events.json: sampleRate must be > 0".into());
        }
        let frames = v["frames"].as_u64().ok_or("events.json: frames must be a non-negative integer")?;
        let list = v["events"].as_array().ok_or("events.json: events must be an array")?;
        let mut events = Vec::with_capacity(list.len());
        for (i, e) in list.iter().enumerate() {
            let frame = e["frame"].as_u64().ok_or_else(|| format!("event {i}: bad frame"))?;
            let key = e["key"].as_u64().filter(|k| *k <= 127).ok_or_else(|| format!("event {i}: key must be 0..127"))?;
            let velocity = e["velocity"].as_f64().ok_or_else(|| format!("event {i}: bad velocity"))?;
            let on = match e["type"].as_str() {
                Some("on") => true,
                Some("off") => false,
                _ => return Err(format!("event {i}: type must be \"on\" or \"off\"").into()),
            };
            events.push(NoteEv { frame: frame as usize, key: key as u16, velocity, on });
        }
        events.sort_by_key(|e| (e.frame, e.on));
        Ok(Score { sample_rate, frames: frames as usize, events })
    }
}

type Error = Box<dyn std::error::Error>;

// ---------------------------------------------------------------- host handlers

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

// ---------------------------------------------------------------- port discovery

struct PortLayout {
    /// Channel count of each audio input port.
    inputs: Vec<usize>,
    /// Channel count of each audio output port.
    outputs: Vec<usize>,
    /// Index of the output port measured (the main port, else port 0).
    measured_output: usize,
}

fn audio_layout(instance: &mut PluginInstance<Host>) -> Result<PortLayout, Error> {
    let ext = instance.access_shared_handler(|s| s.audio_ports.get().copied().flatten());
    let Some(ext) = ext else {
        // CLAP default when the extension is absent: no dedicated ports; assume one stereo output.
        eprintln!("plugin has no audio-ports extension; assuming one stereo output");
        return Ok(PortLayout { inputs: vec![], outputs: vec![2], measured_output: 0 });
    };
    let handle = instance.plugin_handle();
    let mut buf = AudioPortInfoBuffer::new();
    let mut scan = |is_input: bool| -> Result<Vec<(usize, bool)>, Error> {
        (0..ext.count(&handle, is_input))
            .map(|i| {
                let info = ext
                    .get(&handle, i, is_input, &mut buf)
                    .ok_or_else(|| format!("audio port {i} (input={is_input}) info unavailable"))?;
                Ok((info.channel_count as usize, info.flags.contains(AudioPortFlags::IS_MAIN)))
            })
            .collect()
    };
    let inputs = scan(true)?;
    let outputs = scan(false)?;
    if outputs.is_empty() {
        return Err("plugin declares no audio output ports".into());
    }
    let measured_output = outputs.iter().position(|&(_, main)| main).unwrap_or(0);
    if outputs[measured_output].0 == 0 {
        return Err("measured output port has zero channels".into());
    }
    eprintln!(
        "audio ports: inputs {:?}, outputs {:?} (channels, is_main); measuring output {measured_output}",
        inputs, outputs
    );
    Ok(PortLayout {
        inputs: inputs.into_iter().map(|(c, _)| c).collect(),
        outputs: outputs.into_iter().map(|(c, _)| c).collect(),
        measured_output,
    })
}

/// Returns (note port index, use MIDI dialect instead of CLAP note events).
fn note_target(instance: &mut PluginInstance<Host>) -> Result<(u16, bool), Error> {
    let ext = instance.access_shared_handler(|s| s.note_ports.get().copied().flatten());
    let Some(ext) = ext else {
        eprintln!("plugin has no note-ports extension; sending CLAP note events to port 0");
        return Ok((0, false));
    };
    let handle = instance.plugin_handle();
    let count = ext.count(&handle, true);
    if count == 0 {
        return Err("instrument declares no note input ports".into());
    }
    let mut buf = NotePortInfoBuffer::new();
    let info = ext.get(&handle, 0, true, &mut buf).ok_or("note port 0 info unavailable")?;
    let clap = info.supported_dialects.supports(NoteDialect::Clap);
    let midi = info.supported_dialects.supports(NoteDialect::Midi);
    let use_midi = match info.preferred_dialect {
        Some(NoteDialect::Clap) => false,
        Some(NoteDialect::Midi) => true,
        _ if clap => false,
        _ if midi => true,
        _ => return Err("note port 0 supports neither CLAP nor MIDI note dialects".into()),
    };
    eprintln!("note port 0: dialect {}", if use_midi { "MIDI" } else { "CLAP" });
    Ok((0, use_midi))
}

// ---------------------------------------------------------------- rendering

struct Rendered {
    frames: usize,
    rms: f64,
    peak: f64,
    events_delivered: usize,
}

fn render(instance: &mut PluginInstance<Host>, score: &Score) -> Result<Rendered, Error> {
    let layout = audio_layout(instance)?;
    let (note_port, use_midi) = note_target(instance)?;

    let config = PluginAudioConfiguration {
        sample_rate: score.sample_rate,
        min_frames_count: 1,
        max_frames_count: BLOCK as u32,
    };
    let processor = instance.activate(|_, _| (), config)?;

    // Host-owned buffers: [port][channel][frame].
    let mut in_bufs: Vec<Vec<Vec<f32>>> =
        layout.inputs.iter().map(|&c| vec![vec![0.0; BLOCK]; c]).collect();
    let mut out_bufs: Vec<Vec<Vec<f32>>> =
        layout.outputs.iter().map(|&c| vec![vec![0.0; BLOCK]; c]).collect();
    let mut in_ports = AudioPorts::with_capacity(layout.inputs.iter().sum(), layout.inputs.len());
    let mut out_ports =
        AudioPorts::with_capacity(layout.outputs.iter().sum(), layout.outputs.len());
    let measured = layout.measured_output;

    let total_frames = score.frames;
    let score_events = &score.events;

    let audio_thread = std::thread::scope(|scope| -> Result<_, Error> {
        let worker = scope.spawn(move || -> Result<_, String> {
            let mut processor = processor.start_processing().map_err(|e| e.to_string())?;
            let mut events_in = EventBuffer::with_capacity(64);
            let mut next_event = 0usize;
            let mut delivered = 0usize;
            let mut events_out = EventBuffer::with_capacity(64);
            let (mut sum_sq, mut peak, mut samples) = (0.0f64, 0.0f64, 0usize);
            let mut pos = 0usize;
            while pos < total_frames {
                let n = BLOCK.min(total_frames - pos);
                events_in.clear();
                events_out.clear();
                // Every event whose frame falls in [pos, pos + n) goes into this block, at its offset.
                while let Some(ev) = score_events.get(next_event).filter(|e| e.frame < pos + n) {
                    let t = (ev.frame - pos) as u32;
                    let pckn = Pckn::new(note_port, 0u16, ev.key, Match::All);
                    if use_midi {
                        let vel = (ev.velocity * 127.0).round().clamp(1.0, 127.0) as u8;
                        let data = if ev.on { [0x90, ev.key as u8, vel] } else { [0x80, ev.key as u8, 0] };
                        events_in.push(&MidiEvent::new(t, note_port, data));
                    } else if ev.on {
                        events_in.push(&NoteOnEvent::new(t, pckn, ev.velocity));
                    } else {
                        events_in.push(&NoteOffEvent::new(t, pckn, 0.0));
                    }
                    next_event += 1;
                    delivered += 1;
                }
                for port in out_bufs.iter_mut() {
                    for ch in port.iter_mut() {
                        ch.fill(0.0);
                    }
                }
                let inputs = in_ports.with_input_buffers(in_bufs.iter_mut().map(|chans| {
                    AudioPortBuffer {
                        latency: 0,
                        channels: AudioPortBufferType::f32_input_only(
                            chans.iter_mut().map(|b| InputChannel::constant(&mut b[..n])),
                        ),
                    }
                }));
                let mut outputs = out_ports.with_output_buffers(out_bufs.iter_mut().map(|chans| {
                    AudioPortBuffer {
                        latency: 0,
                        channels: AudioPortBufferType::f32_output_only(
                            chans.iter_mut().map(|b| &mut b[..n]),
                        ),
                    }
                }));
                processor
                    .process(
                        &inputs,
                        &mut outputs,
                        &InputEvents::from_buffer(&events_in),
                        &mut OutputEvents::from_buffer(&mut events_out),
                        Some(pos as u64),
                        None,
                    )
                    .map_err(|e| format!("process() failed at frame {pos}: {e}"))?;
                for ch in &out_bufs[measured] {
                    for &s in &ch[..n] {
                        let s = f64::from(s);
                        if !s.is_finite() {
                            return Err(format!("non-finite sample near frame {pos}"));
                        }
                        sum_sq += s * s;
                        peak = peak.max(s.abs());
                        samples += 1;
                    }
                }
                pos += n;
            }
            let stopped = processor.stop_processing();
            let rms = (sum_sq / samples.max(1) as f64).sqrt();
            Ok((stopped, Rendered { frames: pos, rms, peak, events_delivered: delivered }))
        });
        // Main thread: service on_main_thread requests until the audio thread finishes.
        while !worker.is_finished() {
            if instance.access_shared_handler(|s| s.callback_requested.swap(false, Ordering::SeqCst)) {
                instance.call_on_main_thread_callback();
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        worker.join().map_err(|_| "audio thread panicked")?.map_err(Error::from)
    })?;

    let (stopped, rendered) = audio_thread;
    instance.deactivate(stopped);
    Ok(rendered)
}

// ---------------------------------------------------------------- main

fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn run(plugin_path: &str, out_path: &str, events_path: Option<&str>) -> Result<(), Error> {
    let score = match events_path {
        Some(p) => Score::from_json(p)?,
        None => Score::fixed_note(),
    };
    let host_info = HostInfo::new(
        "strudel-caps-clap-host",
        "Strudel capability probes",
        "https://strudel.cc",
        "0.0.0",
    )?;
    // dlopen treats a bare file name as a library-search name, so resolve the path first.
    let plugin_path = std::fs::canonicalize(plugin_path)
        .map_err(|e| format!("cannot resolve {plugin_path}: {e}"))?;
    let plugin_path = plugin_path.to_string_lossy();
    // SAFETY: loading a plugin runs its native initialisation code; that is the point of the spike.
    let entry = unsafe { PluginEntry::load(&*plugin_path) }
        .map_err(|e| format!("cannot load CLAP entry {plugin_path}: {e}"))?;
    let factory = entry.get_plugin_factory().ok_or("bundle exposes no plugin factory")?;

    let mut chosen: Option<(CString, String)> = None;
    for d in factory.plugin_descriptors() {
        let id = d.id().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let name = d.name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let features: Vec<String> = d.features().map(|f| f.to_string_lossy().into_owned()).collect();
        eprintln!("descriptor: id={id} name={name} features={features:?}");
        let is_instrument = features.iter().any(|f| f == "instrument");
        if is_instrument && chosen.is_none() {
            if let Some(raw_id) = d.id() {
                chosen = Some((raw_id.to_owned(), name));
            }
        }
    }
    let (plugin_id, plugin_name) = chosen.ok_or("bundle contains no instrument plugin")?;
    eprintln!("instantiating {}", plugin_id.to_string_lossy());

    let mut instance = PluginInstance::<Host>::new(
        |_| Shared::default(),
        |_| (),
        &entry,
        &plugin_id,
        &host_info,
    )?;
    let rendered = render(&mut instance, &score)?;
    drop(instance);

    let json = format!(
        "{{\"pluginId\":{},\"pluginName\":{},\"frames\":{},\"rms\":{},\"peak\":{},\"eventsDelivered\":{}}}\n",
        json_string(&plugin_id.to_string_lossy()),
        json_string(&plugin_name),
        rendered.frames,
        rendered.rms,
        rendered.peak,
        rendered.events_delivered
    );
    std::fs::write(out_path, &json).map_err(|e| format!("cannot write {out_path}: {e}"))?;
    eprint!("{json}");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 && args.len() != 4 {
        eprintln!("usage: clap-host <plugin.clap> <out.json> [events.json]");
        std::process::exit(2);
    }
    if let Err(e) = run(&args[1], &args[2], args.get(3).map(String::as_str)) {
        eprintln!("clap-host error: {e}");
        std::process::exit(1);
    }
}
