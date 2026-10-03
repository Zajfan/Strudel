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
use std::sync::mpsc::{ channel, Receiver, Sender };
use std::sync::{ Arc, Mutex, OnceLock };
use std::time::{ Duration, Instant, SystemTime, UNIX_EPOCH };

use clack_extensions::audio_ports::{ AudioPortFlags, AudioPortInfoBuffer, PluginAudioPorts };
use clack_extensions::log::{ HostLog, HostLogImpl, LogSeverity };
use clack_extensions::note_ports::{ NoteDialect, NotePortInfoBuffer, PluginNotePorts };
use clack_extensions::params::{ ParamInfoBuffer, ParamInfoFlags, PluginParams };
use clack_extensions::gui::{ GuiApiType, GuiConfiguration, GuiSize, HostGui, HostGuiImpl, PluginGui, Window as ClapWindow };
use clack_extensions::posix_fd::{ FdFlags, HostPosixFd, HostPosixFdImpl, PluginPosixFd };
use clack_extensions::state::PluginState;
use clack_extensions::timer::{ HostTimer, HostTimerImpl, PluginTimer, TimerId };
use std::cell::{ Cell, RefCell };
use std::os::fd::RawFd;

use super::x11window::X11Window;
use clack_host::events::event_types::ParamValueEvent;
use clack_host::events::event_types::{ MidiEvent, NoteOffEvent, NoteOnEvent };
use clack_host::events::Match;
use clack_host::prelude::*;
use cpal::traits::{ DeviceTrait, HostTrait, StreamTrait };
use rtrb::{ Producer, RingBuffer };
use serde::{ Deserialize, Serialize };

// largest block a plugin is asked to render at once; bigger device blocks are split
pub(crate) const BLOCK: usize = 512;
pub(crate) const CHANNELS: usize = 2;
const CAPTURE_SECONDS: usize = 10;

// ------------------------------------------------------------------ CLAP host side

#[derive(Default)]
pub(crate) struct Shared {
  callback_requested: AtomicBool,
  audio_ports: OnceLock<Option<PluginAudioPorts>>,
  note_ports: OnceLock<Option<PluginNotePorts>>,
  params: OnceLock<Option<PluginParams>>,
  gui: OnceLock<Option<PluginGui>>,
  timer: OnceLock<Option<PluginTimer>>,
  posix_fd: OnceLock<Option<PluginPosixFd>>,
  state: OnceLock<Option<PluginState>>,
  // GUI requests from the plugin, handled by its host thread
  gui_closed: AtomicBool,
  gui_resize: Mutex<Option<(u32, u32)>>,
}

impl<'a> SharedHandler<'a> for Shared {
  fn initializing(&self, instance: InitializingPluginHandle<'a>) {
    let _ = self.audio_ports.set(instance.get_extension());
    let _ = self.note_ports.set(instance.get_extension());
    let _ = self.params.set(instance.get_extension());
    let _ = self.gui.set(instance.get_extension());
    let _ = self.timer.set(instance.get_extension());
    let _ = self.posix_fd.set(instance.get_extension());
    let _ = self.state.set(instance.get_extension());
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

impl HostGuiImpl for Shared {
  fn resize_hints_changed(&self) {}
  fn request_resize(&self, size: GuiSize) -> Result<(), HostError> {
    *self.gui_resize.lock().unwrap() = Some((size.width, size.height));
    Ok(())
  }
  fn request_show(&self) -> Result<(), HostError> {
    Ok(())
  }
  fn request_hide(&self) -> Result<(), HostError> {
    Ok(())
  }
  fn closed(&self, _was_destroyed: bool) {
    self.gui_closed.store(true, Ordering::SeqCst);
  }
}

// The plugin's main thread state: timers and file descriptors it registered (plugins with a GUI on
// Linux run their event loop through these), serviced by its host thread.
#[derive(Default)]
pub(crate) struct HostMain {
  timers: RefCell<Vec<(u32, Duration, Instant)>>,
  next_timer: Cell<u32>,
  fds: RefCell<Vec<(RawFd, FdFlags)>>,
}

impl<'a> MainThreadHandler<'a> for HostMain {}

impl HostTimerImpl for HostMain {
  fn register_timer(&self, period_ms: u32) -> Result<TimerId, HostError> {
    let id = self.next_timer.get();
    self.next_timer.set(id + 1);
    let period = Duration::from_millis(period_ms.max(1) as u64);
    self.timers.borrow_mut().push((id, period, Instant::now() + period));
    Ok(TimerId(id))
  }
  fn unregister_timer(&self, timer_id: TimerId) -> Result<(), HostError> {
    self.timers.borrow_mut().retain(|(id, _, _)| *id != timer_id.0);
    Ok(())
  }
}

impl HostPosixFdImpl for HostMain {
  fn register_fd(&self, fd: RawFd, flags: FdFlags) -> Result<(), HostError> {
    self.fds.borrow_mut().push((fd, flags));
    Ok(())
  }
  fn modify_fd(&self, fd: RawFd, flags: FdFlags) -> Result<(), HostError> {
    for entry in self.fds.borrow_mut().iter_mut() {
      if entry.0 == fd {
        entry.1 = flags;
      }
    }
    Ok(())
  }
  fn unregister_fd(&self, fd: RawFd) -> Result<(), HostError> {
    self.fds.borrow_mut().retain(|(f, _)| *f != fd);
    Ok(())
  }
}

pub(crate) struct Host;

impl HostHandlers for Host {
  type Shared<'a> = Shared;
  type MainThread<'a> = HostMain;
  type AudioProcessor<'a> = ();

  fn declare_extensions(builder: &mut HostExtensions<Self>, _shared: &Self::Shared<'_>) {
    builder.register::<HostLog>();
    builder.register::<HostGui>();
    builder.register::<HostTimer>();
    builder.register::<HostPosixFd>();
  }
}


// A parameter a pattern can automate (automatable, not read-only or hidden), in plain values.
#[derive(Clone, Serialize)]
pub struct ParamDesc {
  pub id: u32,
  pub name: String,
  pub module: String,
  pub min: f64,
  pub max: f64,
  pub default: f64,
}

fn params(instance: &mut PluginInstance<Host>) -> Vec<ParamDesc> {
  let Some(ext) = instance.access_shared_handler(|s| s.params.get().copied().flatten()) else {
    return Vec::new();
  };
  let handle = instance.plugin_handle();
  let mut buf = ParamInfoBuffer::new();
  let mut list = Vec::new();
  for i in 0..ext.count(&handle) {
    if let Some(info) = ext.get_info(&handle, i, &mut buf) {
      let skip = ParamInfoFlags::IS_READONLY | ParamInfoFlags::IS_HIDDEN;
      if !info.flags.contains(ParamInfoFlags::IS_AUTOMATABLE) || info.flags.intersects(skip) {
        continue;
      }
      list.push(ParamDesc {
        id: info.id.get(),
        name: String::from_utf8_lossy(info.name).trim_end_matches('\0').to_string(),
        module: String::from_utf8_lossy(info.module).trim_end_matches('\0').to_string(),
        min: info.min_value,
        max: info.max_value,
        default: info.default_value,
      });
    }
  }
  list
}

pub(crate) struct Layout {
  inputs: Vec<usize>,
  outputs: Vec<usize>,
  main_output: usize,
  // an effect's input for the audio it processes
  main_input: Option<usize>,
  note_port: u16,
  use_midi: bool,
  pub(crate) params: Vec<ParamDesc>,
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

fn layout(instance: &mut PluginInstance<Host>, effect: bool) -> Result<Layout, String> {
  // both extensions first: the handle borrows the instance
  let audio_ports = instance.access_shared_handler(|s| s.audio_ports.get().copied().flatten());
  let note_ports = instance.access_shared_handler(|s| s.note_ports.get().copied().flatten());
  let mut handle = instance.plugin_handle();
  let (inputs, outputs, main_output, main_input) = match audio_ports {
    // without the extension, CLAP's default is one stereo output
    None => (vec![], vec![2], 0, None),
    Some(ext) => {
      let inputs = scan_audio_ports(&ext, &mut handle, true);
      let outputs = scan_audio_ports(&ext, &mut handle, false);
      if outputs.is_empty() {
        return Err("the plugin has no audio output".to_string());
      }
      let main_output = outputs.iter().position(|&(_, main)| main).unwrap_or(0);
      let main_input = if inputs.is_empty() { None } else { Some(inputs.iter().position(|&(_, main)| main).unwrap_or(0)) };
      (inputs.into_iter().map(|(c, _)| c).collect(), outputs.into_iter().map(|(c, _)| c).collect(), main_output, main_input)
    }
  };
  if effect && main_input.is_none() {
    return Err("the plugin has no audio input".to_string());
  }
  let (note_port, use_midi) = match note_ports {
    None => (0, false),
    Some(ext) => {
      if ext.count(&mut handle, true) == 0 {
        // an effect needs no notes
        if effect {
          return Ok(Layout { inputs, outputs, main_output, main_input, note_port: 0, use_midi: false, params: params(instance) });
        }
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
  let params = params(instance);
  Ok(Layout { inputs, outputs, main_output, main_input, note_port, use_midi, params })
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
  // and the VST3 plugins (a name that is both plays the CLAP; "vst3:<name>" picks the VST3)
  names.extend(super::vst3::vst3_names());
  names.sort();
  names.dedup();
  names
}

pub(crate) fn find_plugin(name: &str) -> Result<PathBuf, String> {
  clap_dirs()
    .iter()
    .map(|d| d.join(format!("{}.clap", name)))
    .find(|p| p.exists())
    .ok_or_else(|| format!("no CLAP plugin \"{}\". Found: {}", name, plugin_names().join(", ")))
}

// A plugin activated on its host thread, ready for the audio thread. When it is removed, the audio
// thread stops its processor and sends it back through `retire`, so the host thread can deactivate
// the plugin (CLAP: on its main thread) and unload it.
pub(crate) struct NewSlot {
  pub(crate) index: usize,
  processor: StoppedPluginAudioProcessor<Host>,
  pub(crate) layout: Layout,
  retire: Sender<StoppedPluginAudioProcessor<Host>>,
}

// what the audio thread is asked to do with its plugins
enum AudioCommand {
  Add(NewSlot),
  AddVst3(usize, super::vst3::Vst3Slot),
  Remove(usize),
}

// a plugin on the native output: CLAP (rendered in the callback) or VST3 (rendered on the VST3
// thread, which the callback waits for only so long)
enum NativeSlot {
  Clap(Slot),
  Vst3(usize, super::vst3::Vst3Slot),
}

impl NativeSlot {
  fn index(&self) -> usize {
    match self {
      NativeSlot::Clap(slot) => slot.index,
      NativeSlot::Vst3(index, _) => *index,
    }
  }
  fn retire(self) {
    match self {
      NativeSlot::Clap(slot) => slot.retire(),
      NativeSlot::Vst3(_, slot) => super::vst3::unload(slot.id),
    }
  }
}

// The plugin's GUI, while open: in a window of ours (embedded), or the plugin's own (floating).
struct OpenGui {
  window: Option<X11Window>,
}

fn open_gui(instance: &mut PluginInstance<Host>, title: &str) -> Result<OpenGui, String> {
  let gui = instance.access_shared_handler(|s| s.gui.get().copied().flatten()).ok_or("this plugin has no GUI")?;
  let handle = instance.plugin_handle();
  let embedded = || GuiConfiguration { api_type: GuiApiType::X11, is_floating: false };
  let floating = || GuiConfiguration { api_type: GuiApiType::X11, is_floating: true };
  if gui.is_api_supported(&handle, embedded()) {
    gui.create(&handle, embedded()).map_err(|e| format!("cannot create the GUI: {:?}", e))?;
    let size = gui.get_size(&handle).unwrap_or(GuiSize { width: 800, height: 600 });
    let window = X11Window::open(title, size.width, size.height)?;
    // SAFETY: the window lives (in OpenGui) until the GUI is destroyed in close_gui
    unsafe { gui.set_parent(&handle, ClapWindow::from_x11_handle(window.id() as std::ffi::c_ulong)) }.map_err(|e| format!("cannot embed the GUI: {:?}", e))?;
    gui.show(&handle).map_err(|e| format!("cannot show the GUI: {:?}", e))?;
    Ok(OpenGui { window: Some(window) })
  } else if gui.is_api_supported(&handle, floating()) {
    gui.create(&handle, floating()).map_err(|e| format!("cannot create the GUI: {:?}", e))?;
    if let Ok(title) = CString::new(title) {
      gui.suggest_title(&handle, &title);
    }
    gui.show(&handle).map_err(|e| format!("cannot show the GUI: {:?}", e))?;
    Ok(OpenGui { window: None })
  } else {
    Err("this plugin has no X11 GUI".to_string())
  }
}

fn close_gui(instance: &mut PluginInstance<Host>, open: OpenGui) {
  if let Some(gui) = instance.access_shared_handler(|s| s.gui.get().copied().flatten()) {
    let handle = instance.plugin_handle();
    let _ = gui.hide(&handle);
    gui.destroy(&handle);
  }
  drop(open.window);
}

// ------------------------------------------------------------------ the plugins' main thread
// CLAP gives every plugin a main thread, and plugins built on JUCE (like Surge XT) keep process-wide
// state that assumes it is the same thread for all of them. So one thread hosts every plugin of
// the app: it loads and activates them, services their callbacks, timers, file descriptors and
// GUIs, and deactivates and unloads them when the audio side hands their processors back.

enum MainCommand {
  Load { path: PathBuf, index: usize, sample_rate: f64, effect: bool, reply: Sender<Result<Loaded, String>> },
  Gui { id: u64, title: String, show: bool, reply: Sender<Result<(), String>> },
  // saves the plugin's state (load: None) or loads one, replying with the saved bytes (or none)
  State { id: u64, load: Option<Vec<u8>>, reply: Sender<Result<Vec<u8>, String>> },
}

// what an engine gets for a loaded plugin
pub(crate) struct Loaded {
  pub(crate) slot: NewSlot,
  // signalled once the plugin is deactivated and unloaded
  pub(crate) unloaded: Receiver<()>,
  // the plugin on the main thread, for host_gui
  pub(crate) id: u64,
}

struct Hosted {
  id: u64,
  instance: PluginInstance<Host>,
  _entry: PluginEntry,
  gui: Option<OpenGui>,
  retired: Receiver<StoppedPluginAudioProcessor<Host>>,
  unloaded: Sender<()>,
}

fn main_thread() -> Sender<MainCommand> {
  static MAIN: OnceLock<Mutex<Sender<MainCommand>>> = OnceLock::new();
  MAIN
    .get_or_init(|| {
      let (commands, received) = channel();
      std::thread::Builder::new().name("strudel-plugins-main".to_string()).spawn(move || main_loop(received)).unwrap();
      Mutex::new(commands)
    })
    .lock()
    .unwrap()
    .clone()
}

fn instantiate(path: &PathBuf, index: usize, sample_rate: f64, effect: bool, id: u64) -> Result<(Hosted, Loaded), String> {
  let host_info = HostInfo::new("Strudel", "Strudel", "https://strudel.cc", "0.1.0").map_err(|e| e.to_string())?;
  let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
  // SAFETY: loading a plugin runs its native initialisation code, which is what hosting means
  let entry = unsafe { PluginEntry::load(&*path.to_string_lossy()) }.map_err(|e| format!("cannot load {}: {}", path.display(), e))?;
  let factory = entry.get_plugin_factory().ok_or("the bundle has no plugin factory")?;
  let feature: &[u8] = if effect { b"audio-effect" } else { b"instrument" };
  let plugin_id: CString = factory
    .plugin_descriptors()
    .find(|d| d.features().any(|f| f.to_bytes() == feature))
    .and_then(|d| d.id().map(|id| id.to_owned()))
    .ok_or(if effect { "the bundle has no audio effect" } else { "the bundle has no instrument" })?;
  let mut instance =
    PluginInstance::<Host>::new(|_| Shared::default(), |_| HostMain::default(), &entry, &plugin_id, &host_info).map_err(|e| e.to_string())?;
  let layout = layout(&mut instance, effect)?;
  let config = PluginAudioConfiguration { sample_rate, min_frames_count: 1, max_frames_count: BLOCK as u32 };
  let processor = instance.activate(|_, _| (), config).map_err(|e| e.to_string())?;
  let (retire, retired) = channel();
  let (unloaded_tx, unloaded) = channel();
  let hosted = Hosted { id, instance, _entry: entry, gui: None, retired, unloaded: unloaded_tx };
  Ok((hosted, Loaded { slot: NewSlot { index, processor, layout, retire }, unloaded, id }))
}

fn main_loop(commands: Receiver<MainCommand>) {
  let mut plugins: Vec<Hosted> = Vec::new();
  let mut next_id = 0u64;
  loop {
    // with nothing hosted, just wait for work
    if plugins.is_empty() {
      match commands.recv() {
        Ok(command) => handle(command, &mut plugins, &mut next_id),
        Err(_) => return,
      }
    }
    while let Ok(command) = commands.try_recv() {
      handle(command, &mut plugins, &mut next_id);
    }
    // plugins whose processor came back (or was dropped with its stream): deactivate and unload
    let mut i = 0;
    while i < plugins.len() {
      let stopped = match plugins[i].retired.try_recv() {
        Ok(stopped) => Some(Some(stopped)),
        Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(None),
        Err(std::sync::mpsc::TryRecvError::Empty) => None,
      };
      if let Some(stopped) = stopped {
        let mut hosted = plugins.remove(i);
        if let Some(open) = hosted.gui.take() {
          close_gui(&mut hosted.instance, open);
        }
        if let Some(stopped) = stopped {
          hosted.instance.deactivate(stopped);
        }
        let unloaded = hosted.unloaded.clone();
        drop(hosted);
        let _ = unloaded.send(());
        continue;
      }
      i += 1;
    }
    for hosted in plugins.iter_mut() {
      if hosted.instance.access_shared_handler(|s| s.callback_requested.swap(false, Ordering::SeqCst)) {
        hosted.instance.call_on_main_thread_callback();
      }
    }
    service(&mut plugins, Duration::from_millis(5));
    for hosted in plugins.iter_mut() {
      // the window was closed by the user, or the plugin closed its floating window
      let user_closed = hosted.gui.as_ref().and_then(|g| g.window.as_ref()).map_or(false, |w| w.closed());
      let plugin_closed = hosted.instance.access_shared_handler(|s| s.gui_closed.swap(false, Ordering::SeqCst));
      if user_closed || plugin_closed {
        if let Some(open) = hosted.gui.take() {
          close_gui(&mut hosted.instance, open);
        }
      }
      if let Some((width, height)) = hosted.instance.access_shared_handler(|s| s.gui_resize.lock().unwrap().take()) {
        if let Some(window) = hosted.gui.as_ref().and_then(|g| g.window.as_ref()) {
          window.resize(width, height);
          if let Some(ext) = hosted.instance.access_shared_handler(|s| s.gui.get().copied().flatten()) {
            let _ = ext.set_size(&hosted.instance.plugin_handle(), GuiSize { width, height });
          }
        }
      }
    }
  }
}

fn handle(command: MainCommand, plugins: &mut Vec<Hosted>, next_id: &mut u64) {
  match command {
    MainCommand::Load { path, index, sample_rate, effect, reply } => {
      let id = *next_id;
      *next_id += 1;
      let _ = reply.send(instantiate(&path, index, sample_rate, effect, id).map(|(hosted, loaded)| {
        plugins.push(hosted);
        loaded
      }));
    }
    MainCommand::Gui { id, title, show, reply } => {
      let result = match plugins.iter_mut().find(|p| p.id == id) {
        None => Err("the plugin is not loaded".to_string()),
        Some(hosted) if show => {
          if hosted.gui.is_some() {
            Ok(())
          } else {
            open_gui(&mut hosted.instance, &title).map(|open| hosted.gui = Some(open))
          }
        }
        Some(hosted) => {
          if let Some(open) = hosted.gui.take() {
            close_gui(&mut hosted.instance, open);
          }
          Ok(())
        }
      };
      let _ = reply.send(result);
    }
    MainCommand::State { id, load, reply } => {
      let result = (|| {
        let hosted = plugins.iter_mut().find(|p| p.id == id).ok_or("the plugin is not loaded")?;
        let state = hosted.instance.access_shared_handler(|s| s.state.get().copied().flatten()).ok_or("this plugin has no state to save")?;
        let mut handle = hosted.instance.plugin_handle();
        match load {
          Some(bytes) => {
            state.load(&mut handle, &mut bytes.as_slice()).map_err(|e| format!("the plugin did not take the state: {:?}", e))?;
            Ok(Vec::new())
          }
          None => {
            let mut bytes = Vec::new();
            state.save(&mut handle, &mut bytes).map_err(|e| format!("the plugin did not save its state: {:?}", e))?;
            Ok(bytes)
          }
        }
      })();
      let _ = reply.send(result);
    }
  }
}

// One turn for all plugins: waits (at most `max_wait`, less if a timer is due) for their file
// descriptors and GUI windows, then calls their fd and timer callbacks.
fn service(plugins: &mut [Hosted], max_wait: Duration) {
  let now = Instant::now();
  let next_timer = plugins
    .iter()
    .filter_map(|p| p.instance.access_handler(|h| h.timers.borrow().iter().map(|(_, _, due)| *due).min()))
    .min();
  let wait = next_timer.map_or(max_wait, |due| due.saturating_duration_since(now).min(max_wait));
  // (plugin, fd) for each polled descriptor; windows are polled too, with fd None
  let mut owners: Vec<(usize, Option<RawFd>)> = Vec::new();
  let mut polled: Vec<libc::pollfd> = Vec::new();
  for (p, hosted) in plugins.iter().enumerate() {
    for (fd, flags) in hosted.instance.access_handler(|h| h.fds.borrow().clone()) {
      let mut events = 0;
      if flags.contains(FdFlags::READ) {
        events |= libc::POLLIN;
      }
      if flags.contains(FdFlags::WRITE) {
        events |= libc::POLLOUT;
      }
      owners.push((p, Some(fd)));
      polled.push(libc::pollfd { fd, events, revents: 0 });
    }
    if let Some(window) = hosted.gui.as_ref().and_then(|g| g.window.as_ref()) {
      owners.push((p, None));
      polled.push(libc::pollfd { fd: window.fd(), events: libc::POLLIN, revents: 0 });
    }
  }
  if polled.is_empty() {
    std::thread::sleep(wait);
  } else {
    // SAFETY: polled is a valid array of pollfd for the duration of the call
    unsafe { libc::poll(polled.as_mut_ptr(), polled.len() as libc::nfds_t, wait.as_millis() as libc::c_int) };
  }
  for (k, (p, fd)) in owners.iter().enumerate() {
    let (Some(fd), revents) = (fd, polled[k].revents) else {
      continue;
    };
    if revents == 0 {
      continue;
    }
    let mut flags = FdFlags::empty();
    if revents & libc::POLLIN != 0 {
      flags |= FdFlags::READ;
    }
    if revents & libc::POLLOUT != 0 {
      flags |= FdFlags::WRITE;
    }
    if revents & (libc::POLLERR | libc::POLLHUP) != 0 {
      flags |= FdFlags::ERROR;
    }
    let hosted = &mut plugins[*p];
    if let Some(posix_fd) = hosted.instance.access_shared_handler(|s| s.posix_fd.get().copied().flatten()) {
      posix_fd.on_fd(&hosted.instance.plugin_handle(), *fd, flags);
    }
  }
  let now = Instant::now();
  for hosted in plugins.iter_mut() {
    let Some(timer) = hosted.instance.access_shared_handler(|s| s.timer.get().copied().flatten()) else {
      continue;
    };
    let due: Vec<u32> = hosted.instance.access_handler(|h| {
      let mut due = Vec::new();
      for (id, period, next) in h.timers.borrow_mut().iter_mut() {
        if *next <= now {
          due.push(*id);
          *next = now + *period;
        }
      }
      due
    });
    for id in due {
      timer.on_timer(&hosted.instance.plugin_handle(), TimerId(id));
    }
  }
}

// Loads a plugin on the plugins' main thread; returns its activated processor (for an engine's
// audio thread), a signal for when it is unloaded, and its id for host_gui.
pub(crate) fn load_plugin(name: &str, index: usize, sample_rate: f64) -> Result<Loaded, String> {
  load_plugin_kind(name, index, sample_rate, false)
}

// an instrument, or with `effect` an audio effect (the bundle's first plugin of that kind)
pub(crate) fn load_plugin_kind(name: &str, index: usize, sample_rate: f64, effect: bool) -> Result<Loaded, String> {
  let path = find_plugin(name)?;
  let (reply, answer) = channel();
  main_thread().send(MainCommand::Load { path, index, sample_rate, effect, reply }).map_err(|e| e.to_string())?;
  answer.recv().map_err(|e| e.to_string())?
}

// Shows or hides a loaded plugin's GUI, and waits for the answer.
// a plugin window's title: "Surge XT - Strudel", or "bass: Surge XT - Strudel" for an instance by id
pub(crate) fn gui_title(name: &str, plugin: &str) -> String {
  if name == plugin || plugin.is_empty() {
    format!("{} - Strudel", name)
  } else {
    format!("{}: {} - Strudel", name, plugin)
  }
}

pub(crate) fn host_gui(id: u64, title: &str, show: bool) -> Result<(), String> {
  let (reply, answer) = channel();
  main_thread()
    .send(MainCommand::Gui { id, title: title.to_string(), show, reply })
    .map_err(|e| e.to_string())?;
  answer.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?
}

// A plugin's state, as text for a pattern: "clap1:" and the state's bytes, deflated, in base64.
const STATE_PREFIX: &str = "clap1:";

// A state as text: the prefix ("clap1:" or "vst3:"), then the bytes deflated, in base64.
pub(crate) fn encode_state(prefix: &str, bytes: &[u8]) -> Result<String, String> {
  use base64::Engine;
  use std::io::Write;
  let mut deflate = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
  deflate.write_all(bytes).map_err(|e| e.to_string())?;
  let deflated = deflate.finish().map_err(|e| e.to_string())?;
  Ok(format!("{}{}", prefix, base64::engine::general_purpose::STANDARD.encode(deflated)))
}

pub(crate) fn decode_state(prefix: &str, state: &str) -> Result<Vec<u8>, String> {
  use base64::Engine;
  use std::io::Read;
  let encoded = state.trim().strip_prefix(prefix).ok_or_else(|| format!("not a state for this plugin (that starts with \"{}\")", prefix))?;
  let deflated = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| format!("not a plugin state: {}", e))?;
  let mut bytes = Vec::new();
  flate2::read::ZlibDecoder::new(deflated.as_slice()).read_to_end(&mut bytes).map_err(|e| format!("not a plugin state: {}", e))?;
  Ok(bytes)
}

pub(crate) fn save_state(id: u64) -> Result<String, String> {
  let (reply, answer) = channel();
  main_thread().send(MainCommand::State { id, load: None, reply }).map_err(|e| e.to_string())?;
  let bytes = answer.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())??;
  encode_state(STATE_PREFIX, &bytes)
}

pub(crate) fn load_state(id: u64, state: &str) -> Result<(), String> {
  let bytes = decode_state(STATE_PREFIX, state)?;
  let (reply, answer) = channel();
  main_thread().send(MainCommand::State { id, load: Some(bytes), reply }).map_err(|e| e.to_string())?;
  answer.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?.map(|_| ())
}

// Waits (up to 2 s) until an unloaded plugin is gone.
pub(crate) fn wait_unloaded(unloaded: &Receiver<()>, name: &str) -> Result<(), String> {
  unloaded.recv_timeout(Duration::from_secs(2)).map_err(|_| format!("\"{}\" did not unload in time", name))
}

// ------------------------------------------------------------------ audio side

#[derive(Clone, Copy)]
pub(crate) struct NoteEvent {
  pub(crate) plugin: usize,
  pub(crate) due: Instant,
  pub(crate) key: u8,
  pub(crate) velocity: f64,
  pub(crate) on: bool,
}

pub(crate) struct Slot {
  index: usize,
  processor: StartedPluginAudioProcessor<Host>,
  retire: Sender<StoppedPluginAudioProcessor<Host>>,
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
  pub(crate) fn new(new: NewSlot) -> Result<Self, String> {
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
      retire: new.retire,
      layout: new.layout,
      steady: 0,
    })
  }

  // Stops the plugin's processing and hands the processor back to its host thread.
  pub(crate) fn retire(self) {
    let _ = self.retire.send(self.processor.stop_processing());
  }

  // An effect: processes n frames of interleaved stereo `input` with the given parameter changes,
  // adding the result into out (interleaved).
  pub(crate) fn process_with_params(&mut self, input: &[f32], out: &mut [f32], n: usize, params: &[(u32, u32, f64)]) {
    if let Some(port) = self.layout.main_input {
      let chans = &mut self.in_bufs[port];
      let count = chans.len();
      for (c, ch) in chans.iter_mut().enumerate() {
        for i in 0..n {
          ch[i] = if count == 1 { 0.5 * (input[i * CHANNELS] + input[i * CHANNELS + 1]) } else { input[i * CHANNELS + c.min(CHANNELS - 1)] };
        }
      }
    }
    self.render_with_params(out, n, &[], params);
  }

  // Renders n frames with the given (offset, event) notes and (offset, param id, plain value)
  // parameter changes, both in time order, and adds them into out (interleaved).
  pub(crate) fn render_with_params(&mut self, out: &mut [f32], n: usize, notes: &[(u32, NoteEvent)], params: &[(u32, u32, f64)]) {
    self.events_in.clear();
    self.events_out.clear();
    let port = self.layout.note_port;
    // CLAP wants the input events sorted by time: merge the two sorted lists
    let mut p = 0;
    let push_params_until = |events_in: &mut EventBuffer, p: &mut usize, until: u32| {
      while *p < params.len() && params[*p].0 <= until {
        let (offset, id, value) = params[*p];
        if let Some(id) = ClapId::from_raw(id) {
          events_in.push(&ParamValueEvent::new(offset, id, Pckn::match_all(), value));
        }
        *p += 1;
      }
    };
    for (offset, ev) in notes {
      push_params_until(&mut self.events_in, &mut p, *offset);
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
    push_params_until(&mut self.events_in, &mut p, u32::MAX);
    for port in self.out_bufs.iter_mut() {
      for ch in port.iter_mut() {
        ch.fill(0.0);
      }
    }
    let inputs = self.in_ports.with_input_buffers(
      self.in_bufs.iter_mut().map(|chans| AudioPortBuffer {
        latency: 0,
        channels: AudioPortBufferType::f32_input_only(chans.iter_mut().map(|b| InputChannel::variable(&mut b[..n]))),
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
  param_changes: AtomicU64,
  plugins: AtomicU64,
  // VST3 blocks that didn't come back within the callback's budget (played as silence)
  late_blocks: AtomicU64,
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
  param_changes: u64,
  late_blocks: u64,
}

struct Running {
  sample_rate: u32,
  device: String,
  commands: Producer<AudioCommand>,
  // per plugin index: its signal for having unloaded, and its id on the main thread
  unloaded: HashMap<usize, Receiver<()>>,
  host_ids: HashMap<usize, u64>,
  events: Producer<NoteEvent>,
  param_events: Producer<ParamEvent>,
  // each plugin's automatable parameters, by index
  params: HashMap<usize, Vec<ParamDesc>>,
  stop: Sender<()>,
  stats: Arc<Stats>,
  capture: Arc<Mutex<Vec<f32>>>,
  capturing: Arc<AtomicBool>,
  // loaded plugins by instance name (a pattern's id, or else the plugin's name), and which plugin
  // each index is
  plugins: HashMap<String, usize>,
  names: HashMap<usize, String>,
  // the VST3 plugins' ids on the VST3 thread (the others are CLAP, see host_ids)
  vst3_ids: HashMap<usize, u64>,
  next_index: usize,
}

#[derive(Default)]
pub struct PluginEngine {
  running: Mutex<Option<Running>>,
}

// a parameter change for the native output: at a Unix-epoch time (ms), like its notes
#[derive(Deserialize)]
pub struct ParamFromJs {
  time: f64,
  id: u32,
  value: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct ParamEvent {
  plugin: usize,
  due: Instant,
  id: u32,
  value: f64,
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
    let (commands_tx, mut commands_rx) = RingBuffer::<AudioCommand>::new(64);
    let (events_tx, mut events_rx) = RingBuffer::<NoteEvent>::new(8192);
    let (param_tx, mut param_rx) = RingBuffer::<ParamEvent>::new(16384);
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
        let mut slots: Vec<NativeSlot> = Vec::new();
        let mut pacer = super::cue::Pacer::new(sr);
        let mut pending: Vec<NoteEvent> = Vec::new();
        let mut pending_params: Vec<ParamEvent> = Vec::new();
        let mut block_params: Vec<(u32, u32, f64)> = Vec::with_capacity(256);
        let mut block_notes: Vec<(u32, NoteEvent)> = Vec::with_capacity(256);
        let stream = device
          .build_output_stream(
            &config,
            move |out: &mut [f32], info: &cpal::OutputCallbackInfo| {
              out.fill(0.0);
              while let Ok(command) = commands_rx.pop() {
                match command {
                  AudioCommand::Add(new) => {
                    if let Ok(slot) = Slot::new(new) {
                      slots.push(NativeSlot::Clap(slot));
                    }
                  }
                  AudioCommand::AddVst3(index, slot) => slots.push(NativeSlot::Vst3(index, slot)),
                  AudioCommand::Remove(index) => {
                    if let Some(i) = slots.iter().position(|s| s.index() == index) {
                      slots.remove(i).retire();
                    }
                    pending.retain(|ev| ev.plugin != index);
                  }
                }
              }
              while let Ok(ev) = param_rx.pop() {
                pending_params.push(ev);
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
                  let slot_index = slot.index();
                  block_notes.clear();
                  pending.retain(|ev| {
                    if ev.plugin != slot_index || ev.due >= end {
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
                  block_params.clear();
                  pending_params.retain(|ev| {
                    if ev.plugin != slot_index || ev.due >= end {
                      return true;
                    }
                    let offset = if ev.due <= start { 0 } else { ((ev.due - start).as_secs_f64() * sr) as u32 };
                    block_params.push((offset.min(n as u32 - 1), ev.id, ev.value));
                    false
                  });
                  block_params.sort_by_key(|(o, _, _)| *o);
                  t_stats.param_changes.fetch_add(block_params.len() as u64, Ordering::Relaxed);
                  let part = &mut out[done * CHANNELS..(done + n) * CHANNELS];
                  match slot {
                    NativeSlot::Clap(slot) => slot.render_with_params(part, n, &block_notes, &block_params),
                    NativeSlot::Vst3(_, slot) => {
                      let notes = block_notes.iter().map(|(o, e)| (*o, e.key, e.velocity, e.on)).collect();
                      // a quarter of the block's duration at most: the device can't wait
                      let budget = Duration::from_secs_f64(n as f64 / sr / 4.0);
                      if !slot.render_within(part, n, notes, &block_params, budget) {
                        t_stats.late_blocks.fetch_add(1, Ordering::Relaxed);
                      }
                    }
                  }
                }
                done += n;
              }
              t_stats.blocks.fetch_add(1, Ordering::Relaxed);
              t_stats.frames.fetch_add(frames as u64, Ordering::Relaxed);
              t_stats.plugins.store(slots.len() as u64, Ordering::Relaxed);
              if let Some(pacer) = pacer.as_mut() {
                pacer.pace(frames);
              }
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
      commands: commands_tx,
      unloaded: HashMap::new(),
      host_ids: HashMap::new(),
      events: events_tx,
      param_events: param_tx,
      params: HashMap::new(),
      stop,
      stats,
      capture,
      capturing,
      plugins: HashMap::new(),
      names: HashMap::new(),
      vst3_ids: HashMap::new(),
      next_index: 0,
    });
    Ok(())
  }

  // Unloads every plugin (deactivated on its host thread), then closes the stream.
  pub fn stop(&self) {
    let names: Vec<String> = self.loaded();
    for name in names {
      let _ = self.unload(&name);
    }
    if let Some(running) = self.running.lock().unwrap().take() {
      let _ = running.stop.send(());
    }
  }

  // the loaded plugins, in load order
  pub fn loaded(&self) -> Vec<String> {
    let guard = self.running.lock().unwrap();
    let Some(r) = guard.as_ref() else {
      return Vec::new();
    };
    let mut plugins: Vec<(&String, &usize)> = r.plugins.iter().collect();
    plugins.sort_by_key(|(_, i)| **i);
    plugins.into_iter().map(|(n, _)| n.clone()).collect()
  }

  // Removes a plugin from the stream and waits (up to 2 s) until the main thread has unloaded it.
  pub fn unload(&self, plugin: &str) -> Result<(), String> {
    let unloaded = {
      let mut guard = self.running.lock().unwrap();
      let running = guard.as_mut().ok_or("the plugin engine is not running")?;
      let index = running.plugins.remove(plugin).ok_or_else(|| format!("\"{}\" is not loaded", plugin))?;
      running.commands.push(AudioCommand::Remove(index)).map_err(|_| "the audio thread is busy".to_string())?;
      running.host_ids.remove(&index);
      running.names.remove(&index);
      running.vst3_ids.remove(&index);
      running.unloaded.remove(&index)
    };
    if let Some(unloaded) = unloaded {
      wait_unloaded(&unloaded, plugin)?;
    }
    Ok(())
  }

  // a loaded plugin's id on the main thread
  pub fn host_id(&self, plugin: &str) -> Option<u64> {
    let guard = self.running.lock().unwrap();
    let running = guard.as_ref()?;
    running.host_ids.get(running.plugins.get(plugin)?).copied()
  }

  fn vst3_id(&self, plugin: &str) -> Option<u64> {
    let guard = self.running.lock().unwrap();
    let running = guard.as_ref()?;
    running.vst3_ids.get(running.plugins.get(plugin)?).copied()
  }

  // A loaded plugin's state as text (None: not loaded here), and loading one.
  pub fn state(&self, plugin: &str) -> Option<Result<String, String>> {
    if let Some(id) = self.vst3_id(plugin) {
      return Some(super::vst3::save_state_text(id));
    }
    self.host_id(plugin).map(save_state)
  }

  pub fn set_state(&self, plugin: &str, state: &str) -> Option<Result<(), String>> {
    if let Some(id) = self.vst3_id(plugin) {
      return Some(super::vst3::load_state_text(id, state));
    }
    self.host_id(plugin).map(|id| load_state(id, state))
  }

  // Shows or hides a loaded plugin's GUI; Ok(false) if it isn't loaded here.
  pub fn gui(&self, plugin: &str, show: bool) -> Result<bool, String> {
    let which = self.plugin_of(plugin).unwrap_or_default();
    let title = gui_title(plugin, which.strip_prefix("vst3:").or(which.strip_prefix("clap:")).unwrap_or(&which));
    if let Some(id) = self.vst3_id(plugin) {
      super::vst3::gui(id, &title, show)?;
      return Ok(true);
    }
    let id = {
      let guard = self.running.lock().unwrap();
      let Some(running) = guard.as_ref() else {
        return Ok(false);
      };
      let Some(index) = running.plugins.get(plugin) else {
        return Ok(false);
      };
      *running.host_ids.get(index).ok_or("no id for this plugin")?
    };
    host_gui(id, &title, show)?;
    Ok(true)
  }

  // Moves the engine to another output device, reloading the plugins that were loaded.
  pub fn set_device(&self, device: Option<String>) -> Result<(), String> {
    // the plugins come back as they were (patch, GUI tweaks)
    let plugins: Vec<(String, String, Option<String>)> = self
      .loaded()
      .into_iter()
      .filter_map(|name| {
        let plugin = self.plugin_of(&name)?;
        let state = self.state(&name).and_then(|s| s.ok());
        Some((name, plugin, state))
      })
      .collect();
    self.stop();
    self.start(device)?;
    for (name, plugin, state) in plugins {
      self.load_as(&name, &plugin)?;
      if let Some(state) = state {
        self.set_state(&name, &state).transpose()?;
      }
    }
    Ok(())
  }

  // which plugin an instance is
  fn plugin_of(&self, name: &str) -> Option<String> {
    let guard = self.running.lock().unwrap();
    let running = guard.as_ref()?;
    running.names.get(running.plugins.get(name)?).cloned()
  }

  // Loads a plugin (once) under its own name and returns its index.
  #[cfg(test)]
  pub fn load(&self, plugin: &str) -> Result<usize, String> {
    self.load_as(plugin, plugin)
  }

  // Loads a plugin as the instance `name` (once) and returns its index. An instance of another plugin
  // by that name is replaced.
  pub fn load_as(&self, name: &str, plugin: &str) -> Result<usize, String> {
    let vst3_path = match plugin.strip_prefix("vst3:") {
      Some(bare) => Some(super::vst3::find_vst3(bare).ok_or_else(|| format!("no VST3 plugin \"{}\"", bare))?),
      None if find_plugin(plugin.strip_prefix("clap:").unwrap_or(plugin)).is_err() => super::vst3::find_vst3(plugin),
      None => None,
    };
    if self.running.lock().unwrap().is_none() {
      self.start(None)?;
    }
    if self.plugin_of(name).map_or(false, |p| p != plugin) {
      // a swap: only once the new plugin is found
      if vst3_path.is_none() {
        find_plugin(plugin.strip_prefix("clap:").unwrap_or(plugin))?;
      }
      self.unload(name)?;
    }
    let mut guard = self.running.lock().unwrap();
    let running = guard.as_mut().ok_or("the plugin engine is not running")?;
    if let Some(&index) = running.plugins.get(name) {
      return Ok(index);
    }
    let index = running.next_index;
    running.next_index += 1;
    if let Some(path) = vst3_path {
      let (slot, params) = super::vst3::load(path, running.sample_rate as f64, false)?;
      running.params.insert(index, params);
      running.vst3_ids.insert(index, slot.id);
      running.commands.push(AudioCommand::AddVst3(index, slot)).map_err(|_| "the audio thread is busy".to_string())?;
      running.plugins.insert(name.to_string(), index);
      running.names.insert(index, plugin.to_string());
      return Ok(index);
    }
    let Loaded { slot, unloaded, id } = load_plugin(plugin.strip_prefix("clap:").unwrap_or(plugin), index, running.sample_rate as f64)?;
    running.params.insert(index, slot.layout.params.clone());
    running.host_ids.insert(index, id);
    running.unloaded.insert(index, unloaded);
    running.commands.push(AudioCommand::Add(slot)).map_err(|_| "the audio thread is busy".to_string())?;
    running.plugins.insert(name.to_string(), index);
    running.names.insert(index, plugin.to_string());
    Ok(index)
  }

  // Plays notes on the named plugin, loading it (and starting the engine on the default device)
  // first if needed.
  // the parameters a pattern can automate on a loaded plugin; None if it isn't loaded here
  pub fn param_list(&self, plugin: &str) -> Option<Vec<ParamDesc>> {
    let guard = self.running.lock().unwrap();
    let running = guard.as_ref()?;
    running.plugins.get(plugin).and_then(|index| running.params.get(index)).cloned()
  }

  // Parameter changes at absolute times, on a loaded plugin.
  pub fn params(&self, plugin: &str, params: Vec<ParamFromJs>) -> Result<(), String> {
    let mut guard = self.running.lock().unwrap();
    let running = guard.as_mut().ok_or("the plugin engine is not running")?;
    let index = *running.plugins.get(plugin).ok_or_else(|| format!("\"{}\" is not loaded", plugin))?;
    for p in params {
      let ev = ParamEvent { plugin: index, due: epoch_to_instant(p.time), id: p.id, value: p.value };
      running.param_events.push(ev).map_err(|_| "too many queued parameter changes".to_string())?;
    }
    Ok(())
  }

  #[cfg(test)]
  pub fn play(&self, plugin: &str, notes: Vec<NoteFromJs>) -> Result<(), String> {
    self.play_as(plugin, plugin, notes)
  }

  // Plays notes on the instance `name` of a plugin, loading it first if needed.
  pub fn play_as(&self, name: &str, plugin: &str, notes: Vec<NoteFromJs>) -> Result<(), String> {
    let index = self.load_as(name, plugin)?;
    let mut guard = self.running.lock().unwrap();
    let running = guard.as_mut().ok_or("the plugin engine is not running")?;
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
      None => EngineStats { running: false, device: None, sample_rate: 0, plugins: vec![], frames: 0, notes: 0, late_notes: 0, param_changes: 0, late_blocks: 0 },
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
          param_changes: r.stats.param_changes.load(Ordering::Relaxed),
          late_blocks: r.stats.late_blocks.load(Ordering::Relaxed),
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
    crate::audio::cue::tests::silent_alsa_config();
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

  #[test]
  fn plays_a_vst3_plugin_on_the_native_output() {
    if super::super::vst3::find_vst3("Surge XT").is_none() || !std::path::Path::new("/usr/share/alsa/alsa.conf").exists() {
      println!("Surge XT VST3 or ALSA missing, skipping");
      return;
    }
    crate::audio::cue::tests::silent_alsa_config();
    let engine = PluginEngine::default();
    engine.start(Some("strudel_null".to_string())).unwrap();
    engine.capture(true);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
    let notes = [60u8, 64, 67]
      .iter()
      .enumerate()
      .map(|(i, &key)| NoteFromJs { time: now + 800.0 + i as f64 * 200.0, duration: 150.0, key, velocity: 0.8 })
      .collect();
    engine.play_as("v", "vst3:Surge XT", notes).unwrap();
    std::thread::sleep(Duration::from_millis(1800));
    let stats = engine.stats();
    let state = engine.state("v").unwrap().unwrap();
    let captured: Vec<f32> = engine
      .capture(false)
      .chunks_exact(4)
      .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
      .collect();
    engine.stop();
    println!("stats: notes {} late blocks {} frames {}; captured {}", stats.notes, stats.late_blocks, stats.frames, captured.len());
    assert_eq!(stats.notes, 3);
    assert!(state.starts_with("vst3:"));
    let rms = (captured.iter().map(|s| s * s).sum::<f32>() / captured.len().max(1) as f32).sqrt();
    assert!(rms > 0.001, "rms {}", rms);
  }

  #[test]
  fn unloads_plugins_and_moves_them_to_another_device() {
    if find_plugin("Surge XT").is_err() || !std::path::Path::new("/usr/share/alsa/alsa.conf").exists() {
      println!("Surge XT or ALSA missing, skipping");
      return;
    }
    crate::audio::cue::tests::silent_alsa_config();
    let engine = PluginEngine::default();
    engine.start(Some("strudel_null".to_string())).unwrap();
    engine.load("Surge XT").unwrap();
    assert_eq!(engine.loaded(), vec!["Surge XT".to_string()]);
    // a device change keeps the plugins
    engine.set_device(Some("strudel_null".to_string())).unwrap();
    assert_eq!(engine.loaded(), vec!["Surge XT".to_string()]);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(engine.running.lock().unwrap().as_ref().unwrap().stats.plugins.load(Ordering::Relaxed), 1);
    // unloading deactivates it on its host thread and takes it off the stream
    engine.unload("Surge XT").unwrap();
    assert!(engine.loaded().is_empty());
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(engine.running.lock().unwrap().as_ref().unwrap().stats.plugins.load(Ordering::Relaxed), 0);
    assert!(engine.unload("Surge XT").is_err());
    engine.stop();
  }
}
