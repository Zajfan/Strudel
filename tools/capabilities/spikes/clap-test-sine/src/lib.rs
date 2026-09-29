//! Throwaway self-test instrument for the clap-host spike (not Surge XT, never used for PLUG-1 pass).
//! One stereo output, one CLAP note input; plays a 0.25-amplitude sine while a key is held.

use clack_extensions::audio_ports::{
    AudioPortFlags, AudioPortInfo, AudioPortInfoWriter, AudioPortType, PluginAudioPorts,
    PluginAudioPortsImpl,
};
use clack_extensions::note_ports::{
    NoteDialect, NoteDialects, NotePortInfo, NotePortInfoWriter, PluginNotePorts,
    PluginNotePortsImpl,
};
use clack_plugin::events::event_types::{MidiEvent, NoteOffEvent, NoteOnEvent};
use clack_plugin::plugin::features::{INSTRUMENT, STEREO, SYNTHESIZER};
use clack_plugin::prelude::*;

pub struct SinePlugin;

impl Plugin for SinePlugin {
    type AudioProcessor<'a> = SineProcessor;
    type Shared<'a> = ();
    type MainThread<'a> = SineMainThread;

    fn declare_extensions(builder: &mut PluginExtensions<Self>, _shared: Option<&()>) {
        builder.register::<PluginAudioPorts>().register::<PluginNotePorts>();
    }
}

impl DefaultPluginFactory for SinePlugin {
    fn get_descriptor() -> PluginDescriptor {
        PluginDescriptor::new("cc.strudel.caps.test-sine", "Strudel caps test sine")
            .with_features([INSTRUMENT, SYNTHESIZER, STEREO])
    }
    fn new_shared(_host: HostSharedHandle<'_>) -> Result<(), PluginError> {
        Ok(())
    }
    fn new_main_thread<'a>(
        _host: HostMainThreadHandle<'a>,
        _shared: &'a (),
    ) -> Result<SineMainThread, PluginError> {
        Ok(SineMainThread)
    }
}

pub struct SineMainThread;

impl<'a> PluginMainThread<'a, ()> for SineMainThread {}

impl PluginAudioPortsImpl for SineMainThread {
    fn count(&self, is_input: bool) -> u32 {
        if is_input { 0 } else { 1 }
    }
    fn get(&self, index: u32, is_input: bool, writer: &mut AudioPortInfoWriter) {
        if !is_input && index == 0 {
            writer.set(&AudioPortInfo {
                id: ClapId::new(0),
                name: b"Out",
                channel_count: 2,
                flags: AudioPortFlags::IS_MAIN,
                port_type: Some(AudioPortType::STEREO),
                in_place_pair: None,
            });
        }
    }
}

impl PluginNotePortsImpl for SineMainThread {
    fn count(&self, is_input: bool) -> u32 {
        if is_input { 1 } else { 0 }
    }
    fn get(&self, index: u32, is_input: bool, writer: &mut NotePortInfoWriter) {
        if is_input && index == 0 {
            writer.set(&NotePortInfo {
                id: ClapId::new(0),
                name: b"Notes",
                supported_dialects: NoteDialects::CLAP | NoteDialects::MIDI,
                preferred_dialect: Some(NoteDialect::Clap),
            });
        }
    }
}

pub struct SineProcessor {
    sample_rate: f64,
    phase: f64,
    freq: Option<f64>,
}

fn key_to_hz(key: f64) -> f64 {
    440.0 * 2f64.powf((key - 69.0) / 12.0)
}

impl SineProcessor {
    fn handle(&mut self, event: &UnknownEvent) {
        if let Some(e) = event.as_event::<NoteOnEvent>() {
            if let Some(&k) = e.key().as_specific() {
                self.freq = Some(key_to_hz(f64::from(k)));
            }
        } else if event.as_event::<NoteOffEvent>().is_some() {
            self.freq = None;
        } else if let Some(e) = event.as_event::<MidiEvent>() {
            let [status, key, vel] = e.data();
            match status & 0xF0 {
                0x90 if vel > 0 => self.freq = Some(key_to_hz(f64::from(key))),
                0x80 | 0x90 => self.freq = None,
                _ => {}
            }
        }
    }
}

impl<'a> PluginAudioProcessor<'a, (), SineMainThread> for SineProcessor {
    fn activate(
        _host: HostAudioProcessorHandle<'a>,
        _main_thread: &SineMainThread,
        _shared: &'a (),
        config: PluginAudioConfiguration,
    ) -> Result<Self, PluginError> {
        Ok(Self { sample_rate: config.sample_rate, phase: 0.0, freq: None })
    }

    fn process(
        &mut self,
        _process: Process,
        mut audio: Audio,
        events: Events,
    ) -> Result<ProcessStatus, PluginError> {
        let frames = audio.frames_count() as usize;
        let mut mono = vec![0.0f32; frames];
        let mut pending = events.input.iter().peekable();
        for (i, out) in mono.iter_mut().enumerate() {
            while let Some(ev) = pending.peek() {
                if ev.header().time() as usize > i {
                    break;
                }
                self.handle(ev);
                pending.next();
            }
            if let Some(f) = self.freq {
                *out = (0.25 * (self.phase * std::f64::consts::TAU).sin()) as f32;
                self.phase = (self.phase + f / self.sample_rate).fract();
            }
        }
        for ev in pending {
            self.handle(ev);
        }
        let mut port = audio.output_port(0).ok_or(PluginError::Message("no output port"))?;
        let channels = port.channels()?.into_f32().ok_or(PluginError::Message("not f32"))?;
        for ch in channels {
            ch.copy_from_slice(&mono);
        }
        Ok(ProcessStatus::Continue)
    }
}

clack_export_entry!(SinglePluginEntry<SinePlugin>);
