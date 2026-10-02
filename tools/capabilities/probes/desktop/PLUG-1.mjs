// PLUG-1 (desktop): the desktop app plays a pattern on a CLAP instrument, live, from the REPL.
// 1. Through Strudel's mixer (the default for .clap()): the app renders the plugin in Rust for frames
//    of the page's audio clock (src-tauri/src/audio/mixer.rs) and plays it through superdough.
//    Three taps record at once: the plugin's channel, a reference superdough note's orbit, and the
//    master mix. Checked: the plugin reaches the master, its notes start within MAX_SYNC_MS of the
//    reference notes scheduled at the same times, and an orbit effect (room) applies to it.
// 2. Parameter automation: a held note with .auto(saw.range(1, 0), { c: 'Global Volume' }); the
//    plugin's channel must get much quieter across the note.
// 3. On a native output (.clap(name, { output: 'native' })): the engine plays on the harness's
//    silent device; checked through engine_capture and engine_stats, and unloading.
// Without Surge XT in a CLAP folder this is not-run (see the follow-ups doc for installing it).

export const usesPage = true;

const PLUGIN = 'Surge XT';
const SECONDS = 4;
const MAX_SYNC_MS = 3;
const REFERENCE_ORBIT = 3;
const mixerCode = (room) =>
  `setcps(1)\n$: note("c4 ~ ~ ~").clap('${PLUGIN}').room(${room})\n` +
  `$: note("c6 ~ ~ ~").s("sine").gain(0.3).release(0.05).orbit(${REFERENCE_ORBIT})`;
const AUTO_CODE = `setcps(0.5)\nnote("c4").clap('${PLUGIN}').auto(saw.range(1, 0), { c: 'Global Volume' })`;
const NATIVE_CODE = `setcps(1)\nnote("c4 e4 g4 c5").clap('${PLUGIN}', { output: 'native' })`;

// Runs in the page; serialized with toString(), so no closures over Node scope.
async function recordMixer({ code, seconds, plugin, orbit }) {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const controller = getSuperdoughAudioController();
  // the taps exist before playback: the plugin's channel, the reference orbit and the master
  const taps = [getExternalChannel(`clap:${plugin}`).input, controller.getOrbit(orbit, [0, 1]).output, controller.output.destinationGain];
  window.__capsPlugCount = (window.__capsPlugCount ?? 0) + 1;
  const name = `caps-plug-recorder-${window.__capsPlugCount}`;
  const source = `
    class R extends AudioWorkletProcessor {
      constructor() { super(); this.chunks = [[], [], []]; this.on = true;
        this.port.onmessage = () => { this.on = false; this.port.postMessage(this.chunks.map((c) => {
          const out = new Float32Array(c.reduce((n, x) => n + x.length, 0)); let at = 0;
          for (const x of c) { out.set(x, at); at += x.length; } return out; })); }; }
      process(inputs) {
        if (!this.on) return true;
        inputs.forEach((input, k) => this.chunks[k].push(input[0] ? input[0].slice() : new Float32Array(128)));
        return true;
      }
    }
    registerProcessor('${name}', R);`;
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const recorder = new AudioWorkletNode(ctx, name, { numberOfInputs: 3, numberOfOutputs: 1 });
  const sink = new GainNode(ctx, { gain: 0 });
  taps.forEach((tap, k) => tap.connect(recorder, 0, k));
  recorder.connect(sink).connect(ctx.destination);
  const m = window.strudelMirror;
  let recorded;
  try {
    m.setCode(code);
    await m.evaluate();
    const error = String(m.repl.state.error || '');
    if (error) return { error };
    await new Promise((r) => setTimeout(r, seconds * 1000));
    recorded = await new Promise((resolve) => {
      recorder.port.onmessage = (e) => resolve(e.data);
      recorder.port.postMessage('dump');
    });
  } finally {
    m.stop();
    taps.forEach((tap) => tap.disconnect(recorder));
    recorder.disconnect();
    sink.disconnect();
  }
  const b64 = (samples) => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  return { sampleRate: ctx.sampleRate, plugin: b64(recorded[0]), reference: b64(recorded[1]), master: b64(recorded[2]) };
}

async function playNative({ code, seconds, plugin }) {
  const native = window.__TAURI_INTERNALS__;
  await setPluginDevice('strudel_null');
  await native.invoke('engine_capture', { start: true });
  const m = window.strudelMirror;
  try {
    m.setCode(code);
    await m.evaluate();
    const error = String(m.repl.state.error || '');
    if (error) return { error };
    await new Promise((r) => setTimeout(r, seconds * 1000));
  } finally {
    m.stop();
  }
  await new Promise((r) => setTimeout(r, 500));
  const bytes = new Uint8Array(await native.invoke('engine_capture', { start: false }));
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  let sumSq = 0;
  for (const s of samples) sumSq += s * s;
  const stats = await native.invoke('engine_stats');
  await unloadClap(plugin);
  return { stats, rms: samples.length ? Math.sqrt(sumSq / samples.length) : 0, loadedAfterUnload: await loadedClaps() };
}

const decode = (b64) => {
  const bytes = Buffer.from(b64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

// frames where the signal starts after at least `gap` frames below the threshold
function onsets(samples, threshold, gap) {
  const found = [];
  let quiet = gap;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) {
      if (quiet >= gap) found.push(i);
      quiet = 0;
    } else {
      quiet++;
    }
  }
  return found;
}

const rmsOf = (samples, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};
const peak = (xs) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

export async function probe({ page, thresholds }) {
  const notes = { plugin: PLUGIN, mixer: mixerCode('ROOM'), native: NATIVE_CODE };
  if (thresholds.minRms == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold minRms missing' } };
  const plugins = await page.evaluate(() => window.__TAURI_INTERNALS__?.invoke('clap_plugins') ?? null);
  if (plugins === null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'not the desktop app' } };
  if (!plugins.includes(PLUGIN)) {
    return { status: 'not-run', metrics: { plugins }, notes: { ...notes, reason: `${PLUGIN} not installed in a CLAP folder (see the follow-ups doc)` } };
  }

  // 1. through the mixer, dry and with reverb
  const run = (room) =>
    page.evaluate(recordMixer, { code: mixerCode(room), seconds: SECONDS, plugin: PLUGIN, orbit: REFERENCE_ORBIT }, { timeoutMs: (SECONDS + 60) * 1000 });
  const dry = await run(0);
  if (dry.error) return { status: 'fail', metrics: {}, notes: { ...notes, error: dry.error } };
  const wet = await run(0.8);
  if (wet.error) return { status: 'fail', metrics: {}, notes: { ...notes, error: wet.error } };
  const sr = dry.sampleRate;
  const gap = Math.round(0.3 * sr);
  const plugin = decode(dry.plugin);
  const reference = decode(dry.reference);
  const master = decode(dry.master);
  const pluginOnsets = onsets(plugin, 0.05 * peak(plugin), gap);
  const referenceOnsets = onsets(reference, 0.05 * peak(reference), gap);
  // each reference note's nearest plugin note (scheduled at the same time)
  const offsetsMs = referenceOnsets
    .map((r) => pluginOnsets.reduce((best, p) => (Math.abs(p - r) < Math.abs(best - r) ? p : best), Infinity) - r)
    .filter((d) => Number.isFinite(d) && Math.abs(d) < 0.5 * sr)
    .map((d) => (d / sr) * 1000);
  const maxOffsetMs = offsetsMs.length ? Math.max(...offsetsMs.map(Math.abs)) : Infinity;
  // reverb: the master 0.4-0.8 s after each plugin note (the note lasts 0.25 s), wet against dry
  const tail = (rec) => {
    const m = decode(rec.master);
    const p = decode(rec.plugin);
    const parts = onsets(p, 0.05 * peak(p), gap)
      .filter((s) => s + 0.8 * sr < m.length)
      .map((s) => rmsOf(m, s + Math.round(0.4 * sr), s + Math.round(0.8 * sr)));
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  };
  const tailGainDb = 20 * Math.log10(tail(wet) / Math.max(1e-9, tail(dry)));

  // 2. parameter automation, and the parameter list
  const auto = await page.evaluate(recordMixer, { code: AUTO_CODE, seconds: 2.5, plugin: PLUGIN, orbit: REFERENCE_ORBIT }, { timeoutMs: 90000 });
  const paramNames = await page.evaluate(async (plugin) => (await clapParams(plugin)).map((p) => p.name), PLUGIN);
  let automationDropDb = NaN;
  if (!auto.error) {
    const p = decode(auto.plugin);
    const start = onsets(p, 0.05 * peak(p), gap)[0];
    // the note lasts one cycle (2 s): its first and last fifth
    if (start !== undefined && start + 2 * sr <= p.length) {
      const early = rmsOf(p, start + Math.round(0.1 * sr), start + Math.round(0.4 * sr));
      const late = rmsOf(p, start + Math.round(1.5 * sr), start + Math.round(1.8 * sr));
      automationDropDb = 20 * Math.log10(early / Math.max(1e-9, late));
    }
  }

  // 3. on a native output
  const native = await page.evaluate(playNative, { code: NATIVE_CODE, seconds: 3, plugin: PLUGIN }, { timeoutMs: 120000 });
  const metrics = {
    pluginNotes: pluginOnsets.length,
    referenceNotes: referenceOnsets.length,
    syncOffsetsMs: offsetsMs.map((d) => +d.toFixed(2)),
    maxSyncOffsetMs: maxOffsetMs,
    pluginRms: rmsOf(plugin, 0, plugin.length),
    masterRms: rmsOf(master, 0, master.length),
    reverbTailGainDb: tailGainDb,
    automatableParams: paramNames.length,
    automationDropDb,
    native: native.error
      ? { error: native.error }
      : { notes: native.stats.notes, lateNotes: native.stats.lateNotes, device: native.stats.device, rms: native.rms, loadedAfterUnload: native.loadedAfterUnload },
    headline: `${PLUGIN} in the mixer: within ${maxOffsetMs.toFixed(1)} ms of the beat, room +${tailGainDb.toFixed(1)} dB, automation -${automationDropDb.toFixed(0)} dB; native: ${native.stats?.notes ?? 0} notes`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (!(pluginOnsets.length >= SECONDS - 1)) return fail(`${pluginOnsets.length} plugin notes recorded on its channel`);
  if (!(metrics.pluginRms >= thresholds.minRms)) return fail(`plugin rms ${metrics.pluginRms} below ${thresholds.minRms}`);
  if (!(metrics.masterRms >= thresholds.minRms)) return fail('nothing reached the master mix');
  if (!(offsetsMs.length >= SECONDS - 1)) return fail(`only ${offsetsMs.length} plugin notes matched the reference notes`);
  if (!(maxOffsetMs <= MAX_SYNC_MS)) return fail(`plugin notes off the reference by up to ${maxOffsetMs.toFixed(2)} ms`);
  if (!(tailGainDb >= 6)) return fail(`room(0.8) added only ${tailGainDb.toFixed(1)} dB after the plugin notes`);
  if (auto.error) return fail(`automation: ${auto.error}`);
  if (!paramNames.includes('Global Volume')) return fail(`clapParams has no "Global Volume" (${paramNames.length} parameters)`);
  if (!(automationDropDb >= 12)) return fail(`automating Global Volume 1 -> 0 lowered the note by only ${automationDropDb.toFixed(1)} dB`);
  if (native.error) return fail(`native output: ${native.error}`);
  if (!(native.stats.notes >= 11) || native.stats.lateNotes > 0) return fail(`native output: ${native.stats.notes} notes, ${native.stats.lateNotes} late`);
  if (!(native.rms >= thresholds.minRms)) return fail(`native output rms ${native.rms}`);
  if (native.stats.device !== 'strudel_null') return fail(`native output played on ${native.stats.device}`);
  if (native.loadedAfterUnload.length) return fail(`still loaded after unloadClap: ${native.loadedAfterUnload}`);
  return { status: 'pass', metrics, notes };
}
