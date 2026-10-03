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

// per instance name (a pattern's id, or else the plugin's name): { audioContext, plugin,
// ready: Promise<{ index, params, ... }> }, for the current AudioContext;
// params maps a parameter's lower-case name to { id, name, module, min, max, default }
const streams = new Map();

function getStream(name, plugin = name) {
  const audioContext = getAudioContext();
  let stream = streams.get(name);
  if (stream?.audioContext === audioContext && stream.plugin === plugin) return stream;
  // another plugin by this name: its player goes
  stream?.ready.then(({ player }) => player.disconnect()).catch(() => {});
  const ready = (async () => {
    const index = await Invoke('mix_load', { plugin, sampleRate: audioContext.sampleRate, instance: name });
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
        logger(`[clap] ${name}: ${err}`, 'error');
      }
    };
    player.connect(getExternalChannel(`clap:${name}`).input);
    // state: the state last loaded from a pattern (see setState)
    return { index, params, player, state: undefined, stateLoaded: Promise.resolve() };
  })();
  stream = { audioContext, plugin, ready };
  streams.set(name, stream);
  return stream;
}

const toKey = (note) => (typeof note === 'number' ? Math.round(note) : noteToMidi(note));

// The hap's automation curves (see `auto`) that name one of the plugin's parameters, as timed plain
// values: each curve spans the note, and the parameter keeps its last value afterwards. `time` and
// `duration` in any unit (seconds for the mixer, epoch ms for the native output). With a `prefix`
// (lower case), only controls named "<prefix><parameter>" count (effects: "glue:ratio").
export function paramChanges(value, params, time, duration, prefix = '') {
  const changes = [];
  for (const id of value.auto?.__ids ?? []) {
    const { control, curve } = value.auto[id];
    const name = String(control).toLowerCase();
    if (!name.startsWith(prefix)) continue;
    const param = params.get(name.slice(prefix.length));
    if (!param) continue;
    curve.forEach((x, k) => {
      const at = time + (curve.length > 1 ? (duration * k) / (curve.length - 1) : 0);
      changes.push({ time: at, id: param.id, value: Math.min(param.max, Math.max(param.min, x)) });
    });
  }
  return changes;
}

// Loads a pattern's plugin state (.clap(name, { state })) into a mixer instance, once per state.
function setState(instance, state) {
  if (state != null && state !== instance.state) {
    instance.state = state;
    instance.stateLoaded = Invoke('mix_set_state', { plugin: instance.index, state });
  }
  return instance.stateLoaded;
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

function playInMixer(name, plugin, hap, cps, targetTime) {
  // the channel takes the hap's controls (gain, pan, orbit, delay, room, cue, filters) from this time
  const duration = hap.duration.valueOf() / cps;
  // (when the plugin's stream must carry the note: earlier, on an orbit with an effect plugin)
  const time = getExternalChannel(`clap:${name}`).update(hap.value, targetTime, cps, duration);
  getStream(name, plugin)
    .ready.then(async (stream) => {
      await setState(stream, hap.context.clapState);
      await sendToMixer(stream, hap.value, time, duration);
    })
    .catch((err) => logger(`[clap] ${name}: ${err}`, 'error'));
}

// Exports (offline renders): each plugin gets an instance of its own at the export's sample rate, gets
// the notes as the render schedules them, and renders each chunk's audio, which plays through the
// plugin's channel like the live stream does (with either output: an export has one output).
registerOfflineRenderer('clap', {
  start(audioContext) {
    const sampleRate = audioContext.sampleRate;
    // per instance name: Promise<{ index, params, ... }>
    const instances = new Map();
    const instance = (name, plugin) => {
      if (!instances.has(name)) {
        instances.set(
          name,
          (async () => {
            const index = await Invoke('mix_load_instance', { plugin, sampleRate, instance: name });
            const params = new Map((await Invoke('mix_param_list', { plugin: index })).map((p) => [p.name.toLowerCase(), p]));
            // it starts as the live plugin is; a pattern's state goes over that
            return { index, params, state: undefined, stateLoaded: Promise.resolve() };
          })(),
        );
      }
      return instances.get(name);
    };
    return {
      async trigger(hap, t, duration, cps) {
        const { clapPlugin: plugin, clapName: name } = hap.context;
        hap.ensureObjectValue();
        getExternalChannel(`clap:${name}`).update(hap.value, t, cps, duration);
        const loaded = await instance(name, plugin);
        await setState(loaded, hap.context.clapState);
        await sendToMixer(loaded, hap.value, t, duration);
      },
      async render(from, to) {
        const start = Math.round(from * sampleRate);
        const frames = Math.round(to * sampleRate) - start;
        if (frames <= 0) return;
        for (const [name, loading] of instances) {
          const { index } = await loading;
          const samples = new Float32Array(await Invoke('mix_render', { plugin: index, start, frames }));
          const buffer = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate });
          const [left, right] = [buffer.getChannelData(0), buffer.getChannelData(1)];
          for (let i = 0; i < frames; i++) {
            left[i] = samples[i * 2];
            right[i] = samples[i * 2 + 1];
          }
          const source = new AudioBufferSourceNode(audioContext, { buffer });
          source.connect(getExternalChannel(`clap:${name}`).input);
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
// the state last loaded into each plugin on the native output, from a pattern
const nativeStates = new Map();
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

// which plugin each instance name is on the native output: another plugin by that name replaces it
const nativePlugins = new Map();

function playNative(name, plugin, hap, currentTime, cps, targetTime) {
  if (nativePlugins.get(name) !== plugin) {
    nativePlugins.set(name, plugin);
    nativeStates.delete(name);
    nativeParams.delete(name);
  }
  const { note, velocity = 0.9, gain = 1 } = hap.value;
  const time = toEpochMs(targetTime, currentTime);
  const duration = (hap.duration.valueOf() / cps) * 1000;
  const notes = note == null ? [] : [{ time, duration, key: toKey(note), velocity: Math.min(1, gain * velocity) }];
  // clap_play loads the plugin (and starts the engine) if needed; the state and parameters go after it
  const { clapState: state } = hap.context;
  const play =
    state != null && nativeStates.get(name) !== state
      ? Invoke('clap_play', { plugin, notes: [], instance: name }).then(() => {
          nativeStates.set(name, state);
          return Invoke('clap_set_state', { plugin: name, state }).then(() =>
            Invoke('clap_play', { plugin, notes, instance: name }),
          );
        })
      : Invoke('clap_play', { plugin, notes, instance: name });
  play
    .then(async () => {
      if (!hap.value.auto) return;
      const changes = paramChanges(hap.value, await getNativeParams(name), time, duration);
      if (changes.length) await Invoke('clap_params', { plugin: name, params: changes });
    })
    .catch((err) => logger(`[clap] ${err}`, 'error'));
}

/**
 * Plays the pattern's notes on a CLAP instrument plugin (desktop app only), e.g.
 *   note("c3 e3 g3 c4").clap('Surge XT').room(0.3)
 * By default the plugin plays through Strudel's mixer: orbit effects (room, delay, ducking), gain,
 * pan, filters (lpf, hpf, bpf and their envelopes: each note sets them for the whole plugin, like a
 * mono synth's filter), stems and cue apply to it, and it is in time with everything else. Its parameters can be
 * automated with `auto`, by name (clapParams lists them), in their own value range:
 *   note("c2").clap('Surge XT').auto(sine.range(0, 1).slow(4), { c: 'Global Volume' }) `{ output: 'native' }`
 * plays it on the plugin output device instead (lower latency, no Strudel effects; `auto` works too).
 * Uses note and velocity (0-1, default 0.9) per note, and each note's duration. Exports (WAV and
 * stems) include the plugin, through Strudel's mixer with either output.
 * @name clap
 * @param {string} plugin the plugin's file name without .clap, e.g. 'Surge XT'
 * @param {Object} [options]
 * @param {string} [options.output] 'mixer' (default) or 'native'
 * The plugin's state (its patch and everything set in its window) is saved with the pattern by
 * pasting what clapState(name) gives into `state`:
 *   note("c3 e3").clap('Surge XT', { state: 'clap1:eNrtW...' })
 * @param {boolean} [options.gui] open the plugin's own window once it has loaded (see clapGui)
 * Each plugin name is one instance; `id` names separate instances of the same plugin, e.g. two
 * Surge XTs with their own patches:
 *   $: note("c2 g1").clap('Surge XT', { id: 'bass' })
 *   $: note("e4 g4 b4").clap('Surge XT', { id: 'lead' })
 * and clapGui, clapState, clapParams and unloadClap then take the id.
 * @param {string} [options.state] a state from clapState, loaded into the plugin before its notes
 * @param {string} [options.id] the instance's name (default: the plugin's name)
 */
Pattern.prototype.clap = function (plugin, { output = 'mixer', gui = false, state, id } = {}) {
  const name = id ?? plugin;
  const pattern = this.withHap((hap) =>
    hap.setContext({ ...hap.context, offlineRenderer: 'clap', clapPlugin: plugin, clapName: name, clapState: state }),
  );
  return pattern.onTrigger((hap, currentTime, cps, targetTime) => {
    hap.ensureObjectValue();
    if (gui && !guiOpened.has(name)) {
      guiOpened.add(name);
      // once the first note has loaded it
      setTimeout(() => clapGui(name).catch((err) => logger(`[clap] ${name} GUI: ${err}`, 'error')), 500);
    }
    if (output === 'native') {
      playNative(name, plugin, hap, currentTime, cps, targetTime);
    } else {
      playInMixer(name, plugin, hap, cps, targetTime);
    }
  });
};

// plugins whose window .clap(name, { gui: true }) has opened
const guiOpened = new Set();

// Shows (or with show = false, hides) a loaded plugin's own window. The window can also be closed
// with its close button; clapGui(name) opens it again.
export const clapGui = (plugin, show = true) => Invoke('clap_gui', { plugin, show });

// The parameters of a plugin that patterns can automate: [{ id, name, module, min, max, default }].
// (by instance name: a pattern's id, or the plugin's name; loads the plugin by that name if needed)
export const clapParams = async (name) => [...(await getStream(name, streams.get(name)?.plugin ?? name).ready).params.values()];

// the CLAP plugins the desktop app can load, by name
export const clapPlugins = () => Invoke('clap_plugins');

// Moves the plugin engine to another output device, by name as getCueDevices / cue_devices list it
// ('System Standard' or nothing: the default device). Loaded plugins are reloaded there.
export const setPluginDevice = (name) =>
  Invoke('engine_set_device', { device: name && name !== 'System Standard' ? name : null });

/**
 * The state of a loaded plugin (its patch and everything set in its window), as text to save with
 * the pattern: `.clap(name, { state })`. Also copied to the clipboard where the page may.
 * @param {string} plugin the plugin's name, as for clap
 * @returns {Promise<string>}
 */
export const clapState = async (plugin) => {
  const state = await Invoke('clap_state', { plugin });
  const copied = await navigator.clipboard?.writeText(state).then(
    () => true,
    () => false,
  );
  logger(`[clap] ${plugin}: state of ${state.length} characters${copied ? ', copied to the clipboard' : ''}`);
  return state;
};

// the plugins currently loaded, and unloading one (it is loaded again on its next note)
export const loadedClaps = () => Invoke('clap_loaded');
export const unloadClap = async (plugin) => {
  const stream = streams.get(plugin);
  streams.delete(plugin);
  nativeStates.delete(plugin);
  nativeParams.delete(plugin);
  nativePlugins.delete(plugin);
  stream?.ready.then(({ player }) => player.disconnect()).catch(() => {});
  return Invoke('clap_unload', { plugin });
};
