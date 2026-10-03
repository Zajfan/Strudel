// Effect plugins in the desktop app: CLAP audio effects on an orbit or the master, hosted by the Rust
// backend (src-tauri/src/audio/mixer.rs). Registered as superdough's insert provider when running in
// Tauri. An insert sends the orbit's audio to Rust in chunks, Rust runs it through the chain, and the
// result plays LATENCY_FRAMES after the audio went in; superdough schedules everything on that orbit
// that much early, so it is heard at its time (docs/superpowers/plans/2026-10-02-native-desktop-audio.md).
// The audio goes from the insert's worklet straight to a Web Worker, which sends it to Rust through
// the app's `strudelfx` URI scheme: the page's main thread, whose stalls would make chunks late, isn't
// on the way.
import { Pattern, logger, registerEvalHook } from '@strudel/core';
import {
  getAudioContext,
  registerInsertRenderer,
  setInsertProvider,
  setMasterInserts,
  syncOrbitInserts,
} from '@strudel/webaudio';
import { Invoke } from './utils.mjs';
import { paramChanges } from './clap.mjs';

// frames per chunk sent to Rust (one render quantum), and how long after going in the audio comes
// out: the round trip to Rust (measured: under 1 ms) has LATENCY_FRAMES - CHUNK_FRAMES (8 ms at
// 48 kHz) to come back
const CHUNK_FRAMES = 128;
const LATENCY_FRAMES = 1536;
const WARMUP_CHUNKS = 64;

const INSERT = `
class StrudelFxInsert extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(${CHUNK_FRAMES} * 2);
    this.fill = 0;
    this.chunkStart = 0;
    // chunks by their first frame (on the input clock): { samples, processed }
    this.chunks = new Map();
    this.frames = 0;
    this.lateFrames = 0;
    this.ticks = 0;
    // the first frames (since the insert started) of the first late chunks
    this.firstFrame = null;
    this.lateAt = [];
    // late chunks per second since the insert started
    this.lateBySecond = [];
    this.maxAge = [];
    // the worker's port, once connected: chunks go there, processed chunks come back from it
    this.fx = null;
    const onChunk = ({ data }) => {
      if (data.port) {
        this.fx = data.port;
        this.fx.onmessage = onChunk;
        return;
      }
      const chunk = this.chunks.get(data.start);
      if (!chunk) return;
      if (data.samples) {
        chunk.samples = data.samples;
        chunk.processed = true;
        // how long the round trip took, in frames, from when the chunk was complete
        const age = currentFrame - (data.start + ${CHUNK_FRAMES});
        const second = Math.floor((data.start - this.firstFrame) / sampleRate);
        this.maxAge[second] = Math.max(this.maxAge[second] ?? 0, age);
      } else {
        // no chain to run it through: the audio passes as it is
        chunk.passthrough = true;
      }
    };
    this.port.onmessage = onChunk;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const inL = input[0];
    const inR = input[1] ?? inL;
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outL;
    const n = outL.length;
    const now = currentFrame;
    this.firstFrame ??= now;
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.chunkStart = now + i;
      this.chunk[this.fill * 2] = inL ? inL[i] : 0;
      this.chunk[this.fill * 2 + 1] = inR ? inR[i] : 0;
      if (++this.fill === ${CHUNK_FRAMES}) {
        const samples = this.chunk;
        this.chunk = new Float32Array(${CHUNK_FRAMES} * 2);
        this.fill = 0;
        // the dry audio stays here, in case the processed audio comes too late; until the worker
        // is connected (the first few quanta), it passes as it is
        this.chunks.set(this.chunkStart, { samples: samples.slice(), processed: false, passthrough: !this.fx });
        this.fx?.postMessage({ start: this.chunkStart, samples }, [samples.buffer]);
      }
    }
    // output frame f carries input frame f - LATENCY_FRAMES
    for (let i = 0; i < n; i++) {
      const source = now + i - ${LATENCY_FRAMES};
      for (const [start, chunk] of this.chunks) {
        if (source >= start && source < start + ${CHUNK_FRAMES}) {
          const k = (source - start) * 2;
          outL[i] = chunk.samples[k];
          if (outR !== outL) outR[i] = chunk.samples[k + 1];
          this.frames++;
          if (!chunk.processed && !chunk.passthrough) {
            this.lateFrames++;
            if (!chunk.late) {
              chunk.late = true;
              if (this.lateAt.length < 16) this.lateAt.push(start - this.firstFrame);
              const second = Math.floor((start - this.firstFrame) / sampleRate);
              this.lateBySecond[second] = (this.lateBySecond[second] ?? 0) + 1;
            }
          }
          break;
        }
      }
    }
    for (const start of this.chunks.keys()) {
      if (start + ${CHUNK_FRAMES} <= now + n - ${LATENCY_FRAMES}) this.chunks.delete(start);
    }
    if (++this.ticks % 375 === 0) this.port.postMessage({ stats: { frames: this.frames, lateFrames: this.lateFrames, lateAt: this.lateAt, lateBySecond: [...this.lateBySecond].map((x) => x ?? 0), maxAgeFrames: [...this.maxAge].map((x) => x ?? 0) } });
    return true;
  }
}
registerProcessor('strudel-fx-insert', StrudelFxInsert);
`;

// The worker all inserts' audio goes through: per insert, the port of its worklet and the chain to
// run (indices, comma-separated; none: pass the audio as it is). Chunks of one insert go to Rust one
// after another, in order: an effect must see its audio in order.
const FX_WORKER = `
const inserts = new Map();
const slowest = { second: null, ms: 0 };
onmessage = ({ data }) => {
  if (data.port) {
    const insert = { chain: null, port: data.port, queue: Promise.resolve() };
    inserts.set(data.id, insert);
    data.port.onmessage = ({ data: { start, samples } }) => {
      insert.queue = insert.queue.then(() => run(insert, start, samples));
    };
  } else if (data.warm) {
    // rounds on silence through the path the audio takes, before it does
    (async () => {
      const silence = new Float32Array(${CHUNK_FRAMES} * 2);
      for (let k = 0; k < data.rounds; k++) {
        await fetch('strudelfx://localhost/process?chain=' + data.warm + '&start=0', { method: 'POST', body: silence.slice().buffer }).catch(() => {});
      }
      postMessage({ warmed: data.ticket });
    })();
  } else if (data.close) {
    inserts.get(data.id)?.port.close();
    inserts.delete(data.id);
  } else {
    const insert = inserts.get(data.id);
    if (insert) insert.chain = data.chain;
  }
};
async function run(insert, start, samples) {
  if (!insert.chain) {
    insert.port.postMessage({ start, samples: null });
    return;
  }
  const t0 = performance.now();
  try {
    const response = await fetch('strudelfx://localhost/process?chain=' + insert.chain + '&start=' + start, { method: 'POST', body: samples.buffer });
    if (!response.ok) throw new Error(await response.text());
    const processed = new Float32Array(await response.arrayBuffer());
    insert.port.postMessage({ start, samples: processed }, [processed.buffer]);
    // the slowest round trip per second, for fxStats
    const second = Math.floor(performance.now() / 1000);
    const ms = performance.now() - t0;
    if (second !== slowest.second) {
      if (slowest.second != null) postMessage({ slowest: slowest.ms });
      slowest.second = second;
      slowest.ms = 0;
    }
    slowest.ms = Math.max(slowest.ms, ms);
  } catch (err) {
    insert.port.postMessage({ start, samples: null });
    postMessage({ error: String(err) });
  }
}
`;
let fxWorker;
const getFxWorker = () => {
  if (!fxWorker) {
    fxWorker = new Worker(URL.createObjectURL(new Blob([FX_WORKER], { type: 'application/javascript' })));
    let reported = false;
    fxWorker.onmessage = ({ data }) => {
      if (data.warmed != null) {
        warming.get(data.warmed)?.();
        warming.delete(data.warmed);
      }
      if (data.slowest != null) {
        roundTrips.push(+data.slowest.toFixed(1));
        if (roundTrips.length > 120) roundTrips.shift();
      }
      if (data.error && !reported) {
        reported = true;
        logger(`[clapfx] ${data.error}`, 'error');
      }
    };
  }
  return fxWorker;
};
let nextInsertId = 0;
const warming = new Map();
let nextTicket = 0;
const warmUp = (chain) =>
  new Promise((resolve) => {
    const ticket = nextTicket++;
    warming.set(ticket, resolve);
    getFxWorker().postMessage({ warm: chain, rounds: WARMUP_CHUNKS, ticket });
  });
// the slowest round trip to Rust in each of the last seconds (ms)
const roundTrips = [];

const modules = new WeakMap();
const loadInsert = (audioContext) => {
  if (!modules.has(audioContext)) {
    const url = URL.createObjectURL(new Blob([INSERT], { type: 'application/javascript' }));
    modules.set(audioContext, audioContext.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url)));
  }
  return modules.get(audioContext);
};

// An effect's instance name: its id, or else the plugin's name and where it is ("Surge XT Effects
// (orbit 2)"), so the same plugin on two orbits is two instances.
const instanceName = (effect, key) => effect.id ?? `${effect.plugin.replace(/^(clap|vst3):/, '')} (${key})`;

// per insert key ('orbit 2', 'master'): its stats, for fxStats()
const stats = new Map();

function createInsert(audioContext, chain, { key }) {
  const sampleRate = audioContext.sampleRate;
  const input = new GainNode(audioContext, { channelCount: 2, channelCountMode: 'explicit' });
  const output = new GainNode(audioContext);
  // until the worklet is ready: the same latency, unprocessed
  const delay = new DelayNode(audioContext, { maxDelayTime: 1, delayTime: LATENCY_FRAMES / sampleRate });
  input.connect(delay).connect(output);
  let node;
  let closed = false;
  // the chain as loaded: [{ name, index, params }] (null while loading)
  let loaded = null;
  const id = nextInsertId++;
  let loading = 0;
  // the state last loaded into each instance, by name
  const states = new Map();

  const load = async (chain) => {
    const run = ++loading;
    try {
      const effects = [];
      for (const effect of chain) {
        const name = instanceName(effect, key);
        const index = await Invoke('mix_load_fx', { plugin: effect.plugin, sampleRate, instance: name });
        if (effect.state != null && states.get(name) !== effect.state) {
          states.set(name, effect.state);
          await Invoke('mix_set_state', { plugin: index, state: effect.state });
        }
        const params = new Map((await Invoke('mix_param_list', { plugin: index })).map((p) => [p.name.toLowerCase(), p]));
        effects.push({ name, index, params });
      }
      // a new chain's first rounds are slow (the plugins' first processing, the worker's first
      // requests): warm it up on silence, through the worker, before it gets the orbit's audio
      await warmUp(effects.map((e) => e.index).join(','));
      if (run === loading) {
        loaded = effects;
        getFxWorker().postMessage({ id, chain: effects.map((e) => e.index).join(',') || null });
      }
    } catch (err) {
      logger(`[clapfx] ${key}: ${err}`, 'error');
    }
  };
  // the worklet takes over from the delay once the first chain is loaded and warm
  const firstLoad = load(chain);

  Promise.all([loadInsert(audioContext), firstLoad])
    .then(() => {
      if (closed) return;
      node = new AudioWorkletNode(audioContext, 'strudel-fx-insert', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = ({ data }) => {
        if (data.stats) stats.set(key, data.stats);
      };
      // the worklet talks to the worker directly
      const channel = new MessageChannel();
      node.port.postMessage({ port: channel.port1 }, [channel.port1]);
      getFxWorker().postMessage({ id, port: channel.port2 }, [channel.port2]);
      getFxWorker().postMessage({ id, chain: loaded?.map((e) => e.index).join(',') || null });
      input.disconnect(delay);
      delay.disconnect();
      input.connect(node).connect(output);
    })
    .catch((err) => logger(`[clapfx] could not load the insert: ${err}`, 'error'));

  return {
    input,
    output,
    latency: LATENCY_FRAMES / sampleRate,
    setChain: (chain) => load(chain),
    // automation of the effects' parameters: `.auto(signal, { c: '<instance name>:<parameter>' })`
    onHap(value, t, duration) {
      if (!value.auto || !loaded) return;
      for (const effect of loaded) {
        const changes = paramChanges(value, effect.params, t, duration, `${effect.name.toLowerCase()}:`);
        if (changes.length) {
          Invoke('mix_params', { plugin: effect.index, params: changes }).catch((err) => logger(`[clapfx] ${err}`, 'error'));
        }
      }
    },
    disconnect() {
      closed = true;
      fxWorker?.postMessage({ id, close: true });
      loading++;
      input.disconnect();
      delay.disconnect();
      node?.disconnect();
      if (node) node.port.onmessage = null;
      stats.delete(key);
    },
  };
}

setInsertProvider({ create: createInsert });

// how many frames each insert has played, and how many of them came back too late from Rust (and
// were played dry instead): { 'orbit 2': { frames, lateFrames } }
export const fxStats = () => ({ ...Object.fromEntries(stats), roundTripsMs: [...roundTrips] });

const effectOf = (plugin, { id, state, format } = {}) => ({
  plugin: format ? `${format}:${plugin}` : plugin,
  ...(id != null && { id }),
  ...(state != null && { state }),
});

// the effects .clapfx and masterfx name in the code being evaluated (see the eval hook below)
let masterChain = [];
let pendingMasterChain = null;

/**
 * Puts a CLAP audio effect on the pattern's orbit (desktop app only), after the orbit's own effects
 * (delay, room, ducking). Several in a row make a chain, in order:
 *   note("c3 e3").clap('Surge XT').orbit(2).clapfx('Surge XT Effects').clapfx('Compressor', { id: 'glue' })
 * Each effect on each orbit is its own instance, named by its id or else "<plugin> (orbit <n>)";
 * clapGui, clapState and clapParams take that name, and `auto` reaches its parameters as
 * `{ c: '<name>:<parameter>' }`. The orbit's audio is heard ~11 ms after it plays, and everything on
 * the orbit plays that much early, so it stays in time. Haps without clapfx leave the orbit's
 * effects as they are; clapfx(null) removes them (a section without). Exports include the effects,
 * and their changes.
 * @name clapfx
 * @param {string} plugin the plugin's file name without .clap
 * @param {Object} [options]
 * @param {string} [options.id] the instance's name
 * @param {string} [options.state] a state from clapState, loaded before it runs
 * @param {string} [options.format] 'clap' or 'vst3', as for clap
 */
Pattern.prototype.clapfx = function (plugin, options) {
  // clapfx(null): no effects on the orbit (from these haps on)
  if (plugin == null) {
    return this.withValue((v) => ({ ...(typeof v === 'object' ? v : {}), inserts: [] }));
  }
  const effect = effectOf(plugin, options);
  return this.withValue((v) => {
    const value = typeof v === 'object' ? v : {};
    return { ...value, inserts: [...(value.inserts ?? []), effect] };
  });
};

/**
 * Puts a CLAP audio effect on the master (the whole mix), after the orbits; call it more than once
 * for a chain. Like clapfx, but a statement of its own: masterfx('Limiter'). Code without masterfx
 * removes the master's effects.
 * @param {string} plugin the plugin's file name without .clap
 * @param {Object} [options] as for clapfx
 */
export function masterfx(plugin, options) {
  (pendingMasterChain ??= []).push(effectOf(plugin, options));
}

// The chains an evaluated pattern sets per orbit, from its haps over the next cycles.
const LOOKAHEAD_CYCLES = 4;
function orbitChains(pattern, cycle) {
  const chains = new Map();
  for (const hap of pattern.queryArc(cycle, cycle + LOOKAHEAD_CYCLES)) {
    const value = hap.value;
    if (typeof value !== 'object' || value.inserts === undefined || value.cue) continue;
    chains.set(Number(value.orbit ?? 1), value.inserts);
  }
  return chains;
}

registerEvalHook({
  before() {
    pendingMasterChain = [];
  },
  after({ pattern, cycle }) {
    masterChain = pendingMasterChain ?? [];
    pendingMasterChain = null;
    setMasterInserts(masterChain);
    try {
      syncOrbitInserts(orbitChains(pattern, Math.floor(cycle ?? 0)));
    } catch (err) {
      logger(`[clapfx] ${err}`, 'error');
    }
  },
});

// ------------------------------------------------------------------ exports
// A render with inserts is rendered as stems (webaudio.mjs); each orbit's stem then runs through its
// orbit's chain, the stems are summed, and the sum through the master's chain, all in Rust with an
// instance of each effect of its own, from the live one's state, at the render's sample rate.
registerInsertRenderer({
  masterChain: () => masterChain,
  async process({ stems, segments, master, haps, sampleRate }) {
    const loadedInstances = [];
    // the render's own instance of each effect, by name (as live: a name keeps its instance, and
    // its state, across chain changes)
    const instances = new Map();
    const loadChain = async (chain, key) => {
      const effects = [];
      for (const effect of chain) {
        const name = instanceName(effect, key);
        if (!instances.has(name)) {
          const index = await Invoke('mix_load_fx_instance', { plugin: effect.plugin, sampleRate, instance: name });
          loadedInstances.push(index);
          if (effect.state != null) await Invoke('mix_set_state', { plugin: index, state: effect.state });
          const params = new Map((await Invoke('mix_param_list', { plugin: index })).map((p) => [p.name.toLowerCase(), p]));
          instances.set(name, { name, index, params });
        }
        effects.push(instances.get(name));
      }
      return effects;
    };
    // automation, at the haps' times (a render has no latency)
    const automate = async (effects, orbit) => {
      for (const { value, t, duration } of haps) {
        if (!value.auto || (orbit != null && Number(value.orbit ?? 1) !== orbit) || value.cue) continue;
        for (const effect of effects) {
          const changes = paramChanges(value, effect.params, t, duration, `${effect.name.toLowerCase()}:`);
          if (changes.length) await Invoke('mix_params', { plugin: effect.index, params: changes });
        }
      }
    };
    // runs the buffer through the chain of each part: [{ from (frame), effects }], in order (an
    // empty chain passes the audio as it is)
    const run = async (buffer, parts) => {
      const frames = buffer.length;
      const [left, right] = [buffer.getChannelData(0), buffer.getChannelData(1)];
      const out = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate });
      const [outL, outR] = [out.getChannelData(0), out.getChannelData(1)];
      const step = 8192;
      for (let start = 0; start < frames; ) {
        const k = parts.findLastIndex((p) => p.from <= start);
        const effects = k < 0 ? [] : parts[k].effects;
        const partEnd = parts[k + 1]?.from ?? frames;
        const n = Math.min(step, partEnd - start, frames - start);
        if (!effects.length) {
          outL.set(left.subarray(start, start + n), start);
          outR.set(right.subarray(start, start + n), start);
          start += n;
          continue;
        }
        const chunk = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          chunk[i * 2] = left[start + i];
          chunk[i * 2 + 1] = right[start + i];
        }
        const bytes = await Invoke('mix_process', new Uint8Array(chunk.buffer), {
          headers: { 'x-chain': effects.map((e) => e.index).join(','), 'x-start': String(start) },
        });
        const processed = new Float32Array(bytes);
        for (let i = 0; i < n; i++) {
          outL[start + i] = processed[i * 2];
          outR[start + i] = processed[i * 2 + 1];
        }
        start += n;
      }
      return out;
    };
    try {
      const processedStems = new Map();
      for (const [orbit, stem] of stems) {
        const list = segments.get(orbit) ?? [];
        if (!list.some((s) => s.chain?.length)) {
          processedStems.set(orbit, stem);
          continue;
        }
        const parts = [];
        for (const { t, chain } of list) {
          parts.push({ from: Math.max(0, Math.round(t * sampleRate)), effects: await loadChain(chain ?? [], `orbit ${orbit}`) });
        }
        await automate([...new Set(parts.flatMap((p) => p.effects))], orbit);
        processedStems.set(orbit, await run(stem, parts));
      }
      const length = [...stems.values()][0]?.length ?? 0;
      let mix = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, length), sampleRate });
      for (const stem of processedStems.values()) {
        for (const side of [0, 1]) {
          const sum = mix.getChannelData(side);
          const part = stem.getChannelData(side);
          for (let i = 0; i < length; i++) sum[i] += part[i];
        }
      }
      if (master?.length) {
        const effects = await loadChain(master, 'master');
        await automate(effects, null);
        mix = await run(mix, [{ from: 0, effects }]);
      }
      return { stems: processedStems, mix };
    } finally {
      for (const index of loadedInstances) {
        await Invoke('mix_unload', { plugin: index }).catch(() => {});
      }
    }
  },
});
