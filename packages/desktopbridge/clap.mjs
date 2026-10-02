// Plugins in the desktop app: .clap(name) plays a pattern's notes on a CLAP instrument hosted by the
// Rust backend (src-tauri/src/audio: mixer.rs, plugins.rs). The plugin is looked up by
// file name ("Surge XT" for "Surge XT.clap") in CLAP_PATH, ~/.clap, /usr/lib/clap and
// /usr/lib64/clap, and loaded on first use. A stand-in for the VersaTone engine
// (docs/superpowers/plans/2026-10-02-native-desktop-audio.md).
import { Pattern, logger, noteToMidi } from '@strudel/core';
import { getAudioContext, getExternalChannel, registerOfflineRenderer } from '@strudel/webaudio';
import { Invoke, toEpochMs } from './utils.mjs';

// ------------------------------------------------------------------ in the page's mixer (default)
// The plugin plays as a stream through superdough (getExternalChannel): orbit effects, ducking,
// stems and cue apply, and it shares the page's single output, so it is in time with everything else.
// Rust renders the plugin's audio on request, for frames of the page's audio clock; a player worklet
// asks for the next chunk when its buffer runs low and plays every chunk at its frames.

// frames per render request, and how far ahead the player keeps audio. Rendering must stay behind
// what the notes are known for (~100 ms: the scheduler's latency), so: ahead at most ~60 ms.
const CHUNK_FRAMES = 1024;
const BUFFER_FRAMES = 1536;
const START_LEAD_FRAMES = 256;

const PLAYER = `
class StrudelPluginPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.waiting = false;
    this.port.onmessage = (e) => {
      if (e.data.samples) this.chunks.push(e.data);
      this.waiting = false;
    };
  }
  process(inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] ?? left;
    const now = currentFrame;
    const n = left.length;
    while (this.chunks.length && this.chunks[0].start + this.chunks[0].samples.length / 2 <= now) this.chunks.shift();
    for (const c of this.chunks) {
      const from = Math.max(now, c.start);
      const to = Math.min(now + n, c.start + c.samples.length / 2);
      for (let f = from; f < to; f++) {
        const i = (f - c.start) * 2;
        left[f - now] += c.samples[i];
        right[f - now] += c.samples[i + 1];
      }
    }
    const last = this.chunks[this.chunks.length - 1];
    const end = last ? last.start + last.samples.length / 2 : now;
    if (!this.waiting && end - now < ${BUFFER_FRAMES}) {
      this.waiting = true;
      this.port.postMessage({ start: Math.max(end, now + ${START_LEAD_FRAMES}), frames: ${CHUNK_FRAMES} });
    }
    return true;
  }
}
registerProcessor('strudel-plugin-player', StrudelPluginPlayer);
`;

const playerModules = new WeakMap();
const loadPlayer = (audioContext) => {
  if (!playerModules.has(audioContext)) {
    const url = URL.createObjectURL(new Blob([PLAYER], { type: 'application/javascript' }));
    playerModules.set(audioContext, audioContext.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url)));
  }
  return playerModules.get(audioContext);
};

// per plugin: { audioContext, ready: Promise<{ index, params }> }, for the current AudioContext;
// params maps a parameter's lower-case name to { id, name, module, min, max, default }
const streams = new Map();

function getStream(plugin) {
  const audioContext = getAudioContext();
  let stream = streams.get(plugin);
  if (stream?.audioContext === audioContext) return stream;
  const ready = (async () => {
    const index = await Invoke('mix_load', { plugin, sampleRate: audioContext.sampleRate });
    const params = new Map((await Invoke('mix_param_list', { plugin: index })).map((p) => [p.name.toLowerCase(), p]));
    await loadPlayer(audioContext);
    const player = new AudioWorkletNode(audioContext, 'strudel-plugin-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    player.port.onmessage = async ({ data: { start, frames } }) => {
      try {
        const bytes = await Invoke('mix_render', { plugin: index, start, frames });
        const samples = new Float32Array(bytes);
        player.port.postMessage({ start, samples }, [samples.buffer]);
      } catch (err) {
        player.port.postMessage({});
        logger(`[clap] ${plugin}: ${err}`, 'error');
      }
    };
    player.connect(getExternalChannel(`clap:${plugin}`).input);
    return { index, params };
  })();
  stream = { audioContext, ready };
  streams.set(plugin, stream);
  return stream;
}

const toKey = (note) => (typeof note === 'number' ? Math.round(note) : noteToMidi(note));

// The hap's automation curves (see `auto`) that name one of the plugin's parameters, as timed plain
// values: each curve spans the note, and the parameter keeps its last value afterwards. `time` and
// `duration` in any unit (seconds for the mixer, epoch ms for the native output).
function paramChanges(value, params, time, duration) {
  const changes = [];
  for (const id of value.auto?.__ids ?? []) {
    const { control, curve } = value.auto[id];
    const param = params.get(String(control).toLowerCase());
    if (!param) continue;
    curve.forEach((x, k) => {
      const at = time + (curve.length > 1 ? (duration * k) / (curve.length - 1) : 0);
      changes.push({ time: at, id: param.id, value: Math.min(param.max, Math.max(param.min, x)) });
    });
  }
  return changes;
}

// sends a hap's note and parameter changes to a plugin in the mixer engine, `time` in seconds
async function sendToMixer({ index, params }, value, time, duration) {
  const { note, velocity = 0.9 } = value;
  const changes = paramChanges(value, params, time, duration);
  if (changes.length) await Invoke('mix_params', { plugin: index, params: changes });
  if (note == null) return;
  const notes = [{ time, duration, key: toKey(note), velocity: Math.min(1, velocity) }];
  await Invoke('mix_notes', { plugin: index, notes });
}

function playInMixer(plugin, hap, cps, targetTime) {
  // the channel takes the orbit-level controls (gain, pan, orbit, delay, room, cue) from this time
  getExternalChannel(`clap:${plugin}`).update(hap.value, targetTime, cps);
  const duration = hap.duration.valueOf() / cps;
  getStream(plugin)
    .ready.then((stream) => sendToMixer(stream, hap.value, targetTime, duration))
    .catch((err) => logger(`[clap] ${plugin}: ${err}`, 'error'));
}

// Exports (offline renders): each plugin gets an instance of its own at the export's sample rate, gets
// the notes as the render schedules them, and renders each chunk's audio, which plays through the
// plugin's channel like the live stream does (with either output: an export has one output).
registerOfflineRenderer('clap', {
  start(audioContext) {
    const sampleRate = audioContext.sampleRate;
    // per plugin: Promise<{ index, params }>
    const instances = new Map();
    const instance = (plugin) => {
      if (!instances.has(plugin)) {
        instances.set(
          plugin,
          (async () => {
            const index = await Invoke('mix_load_instance', { plugin, sampleRate });
            const params = new Map((await Invoke('mix_param_list', { plugin: index })).map((p) => [p.name.toLowerCase(), p]));
            return { index, params };
          })(),
        );
      }
      return instances.get(plugin);
    };
    return {
      async trigger(hap, t, duration, cps) {
        const { clapPlugin: plugin } = hap.context;
        hap.ensureObjectValue();
        getExternalChannel(`clap:${plugin}`).update(hap.value, t, cps);
        await sendToMixer(await instance(plugin), hap.value, t, duration);
      },
      async render(from, to) {
        const start = Math.round(from * sampleRate);
        const frames = Math.round(to * sampleRate) - start;
        if (frames <= 0) return;
        for (const [plugin, loading] of instances) {
          const { index } = await loading;
          const samples = new Float32Array(await Invoke('mix_render', { plugin: index, start, frames }));
          const buffer = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate });
          const [left, right] = [buffer.getChannelData(0), buffer.getChannelData(1)];
          for (let i = 0; i < frames; i++) {
            left[i] = samples[i * 2];
            right[i] = samples[i * 2 + 1];
          }
          const source = new AudioBufferSourceNode(audioContext, { buffer });
          source.connect(getExternalChannel(`clap:${plugin}`).input);
          source.start(start / sampleRate);
        }
      },
      async end() {
        for (const loading of instances.values()) {
          const { index } = await loading.catch(() => ({}));
          if (index != null) await Invoke('mix_unload', { plugin: index });
        }
      },
    };
  },
});

// ------------------------------------------------------------------ on a native output
// Lower latency, but outside the page's mixer: no Strudel effects, and only approximately in time
// with the page's audio (both reach the OS mixer on their own).
// the native output's parameter lists, by plugin (fetched once it has loaded the plugin)
const nativeParams = new Map();
const getNativeParams = (plugin) => {
  if (!nativeParams.has(plugin)) {
    const list = Invoke('clap_param_list', { plugin }).then((params) => new Map(params.map((p) => [p.name.toLowerCase(), p])));
    list.catch(() => nativeParams.delete(plugin));
    nativeParams.set(plugin, list);
  }
  return nativeParams.get(plugin);
};

function playNative(plugin, hap, currentTime, cps, targetTime) {
  const { note, velocity = 0.9, gain = 1 } = hap.value;
  const time = toEpochMs(targetTime, currentTime);
  const duration = (hap.duration.valueOf() / cps) * 1000;
  const notes = note == null ? [] : [{ time, duration, key: toKey(note), velocity: Math.min(1, gain * velocity) }];
  // clap_play loads the plugin (and starts the engine) if needed; parameters go after it
  Invoke('clap_play', { plugin, notes })
    .then(async () => {
      if (!hap.value.auto) return;
      const changes = paramChanges(hap.value, await getNativeParams(plugin), time, duration);
      if (changes.length) await Invoke('clap_params', { plugin, params: changes });
    })
    .catch((err) => logger(`[clap] ${err}`, 'error'));
}

/**
 * Plays the pattern's notes on a CLAP instrument plugin (desktop app only), e.g.
 *   note("c3 e3 g3 c4").clap('Surge XT').room(0.3)
 * By default the plugin plays through Strudel's mixer: orbit effects (room, delay, ducking), gain,
 * pan, stems and cue apply to it, and it is in time with everything else. Its parameters can be
 * automated with `auto`, by name (clapParams lists them), in their own value range:
 *   note("c2").clap('Surge XT').auto(sine.range(0, 1).slow(4), { c: 'Global Volume' }) `{ output: 'native' }`
 * plays it on the plugin output device instead (lower latency, no Strudel effects; `auto` works too).
 * Uses note and velocity (0-1, default 0.9) per note, and each note's duration. Exports (WAV and
 * stems) include the plugin, through Strudel's mixer with either output.
 * @name clap
 * @param {string} plugin the plugin's file name without .clap, e.g. 'Surge XT'
 * @param {Object} [options]
 * @param {string} [options.output] 'mixer' (default) or 'native'
 * @param {boolean} [options.gui] open the plugin's own window once it has loaded (see clapGui)
 */
Pattern.prototype.clap = function (plugin, { output = 'mixer', gui = false } = {}) {
  const pattern = this.withHap((hap) => hap.setContext({ ...hap.context, offlineRenderer: 'clap', clapPlugin: plugin }));
  return pattern.onTrigger((hap, currentTime, cps, targetTime) => {
    hap.ensureObjectValue();
    if (gui && !guiOpened.has(plugin)) {
      guiOpened.add(plugin);
      // once the first note has loaded it
      setTimeout(() => clapGui(plugin).catch((err) => logger(`[clap] ${plugin} GUI: ${err}`, 'error')), 500);
    }
    if (output === 'native') {
      playNative(plugin, hap, currentTime, cps, targetTime);
    } else {
      playInMixer(plugin, hap, cps, targetTime);
    }
  });
};

// plugins whose window .clap(name, { gui: true }) has opened
const guiOpened = new Set();

// Shows (or with show = false, hides) a loaded plugin's own window. The window can also be closed
// with its close button; clapGui(name) opens it again.
export const clapGui = (plugin, show = true) => Invoke('clap_gui', { plugin, show });

// The parameters of a plugin that patterns can automate: [{ id, name, module, min, max, default }].
export const clapParams = async (plugin) => [...(await getStream(plugin).ready).params.values()];

// the CLAP plugins the desktop app can load, by name
export const clapPlugins = () => Invoke('clap_plugins');

// Moves the plugin engine to another output device, by name as getCueDevices / cue_devices list it
// ('System Standard' or nothing: the default device). Loaded plugins are reloaded there.
export const setPluginDevice = (name) =>
  Invoke('engine_set_device', { device: name && name !== 'System Standard' ? name : null });

// the plugins currently loaded, and unloading one (it is loaded again on its next note)
export const loadedClaps = () => Invoke('clap_loaded');
export const unloadClap = (plugin) => Invoke('clap_unload', { plugin });
