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
// 4. The plugin's GUI: clapGui opens it in its own window (on the app's Xvfb display), which must
//    show something (not one flat colour), and closes it again.
// 5. Exports: an offline stem render of a pattern with the plugin on orbit 2 and a sine on orbit 1.
//    The plugin's stem must hold its notes, each within MAX_EXPORT_MS of its time, and only its stem.
// 6. Filters on the plugin's stream, in offline renders: lpf(300) must make it much darker, hpf(3000)
//    brighter, and a filter envelope (lpf(200).lpenv(6), short decay) bright at each note's start
//    and dark after. Brightness: the rms of the first difference over the rms.
// 7. State: with the plugin freshly loaded, clapState gives its default state; after its volume is
//    automated to 0 live, a different (muted) one. An export without a state starts as the live
//    plugin is (silent); with { state: default } it sounds, and with { state: muted } it doesn't.
// Without Surge XT in a CLAP folder this is not-run (see the follow-ups doc for installing it).

import { execFileSync } from 'node:child_process';
import { renderStemsInPage } from '../../lib/browser/page-render.mjs';

export const usesPage = true;

const PLUGIN = 'Surge XT';
const SECONDS = 4;
const MAX_SYNC_MS = 3;
const REFERENCE_ORBIT = 3;
// Surge XT's onsets spread more at 48 kHz (up to ~2 ms late in the Rust tests) and a fresh instance's
// first note a little more; a broken export is off by far more (a chunk, a sample-rate mismatch)
const MAX_EXPORT_MS = 5;
const mixerCode = (room) =>
  `setcps(1)\n$: note("c4 ~ ~ ~").clap('${PLUGIN}').room(${room})\n` +
  `$: note("c6 ~ ~ ~").s("sine").gain(0.3).release(0.05).orbit(${REFERENCE_ORBIT})`;
const AUTO_CODE = `setcps(0.5)\nnote("c4").clap('${PLUGIN}').auto(saw.range(1, 0), { c: 'Global Volume' })`;
const NATIVE_CODE = `setcps(1)\nnote("c4 e4 g4 c5").clap('${PLUGIN}', { output: 'native' })`;
// the same, with the plugin's volume automated (to 0)
const NATIVE_MUTED_CODE = `setcps(1)\nnote("c4 e4 g4 c5").clap('${PLUGIN}', { output: 'native' }).auto(0, { c: 'Global Volume' })`;

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

async function playNative({ code, seconds, plugin, unload = true }) {
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
  if (unload) await unloadClap(plugin);
  return { stats, samples: samples.length, rms: samples.length ? Math.sqrt(sumSq / samples.length) : 0, loadedAfterUnload: await loadedClaps() };
}

// plays code for a while in the page
async function playFor({ code, seconds }) {
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
  return {};
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

  // 4. the GUI (while the plugin is loaded in the mixer, from part 1)
  const guiTitle = `${PLUGIN} - Strudel`;
  const windows = () => execFileSync('xwininfo', ['-display', page.display, '-root', '-tree'], { encoding: 'utf8' });
  const guiOpen = await page.evaluate(async (plugin) => {
    try {
      await clapGui(plugin);
      await new Promise((r) => setTimeout(r, 3000));
      return {};
    } catch (err) {
      return { error: String(err) };
    }
  }, PLUGIN);
  const guiLine = guiOpen.error ? undefined : windows().split('\n').find((l) => l.includes(`"${guiTitle}"`));
  const guiId = guiLine?.trim().split(' ')[0];
  const [guiWidth, guiHeight] = (guiLine?.match(/(\d+)x(\d+)\+/) ?? []).slice(1).map(Number);
  // distinct colours in the window: a drawn GUI has many, an empty window one
  const guiColours = guiId
    ? Number(execFileSync('convert', ['-', '-format', '%k', 'info:'], { input: execFileSync('import', ['-display', page.display, '-window', guiId, 'png:-']) }).toString())
    : 0;
  await page.evaluate((plugin) => clapGui(plugin, false), PLUGIN);
  await new Promise((r) => setTimeout(r, 500));
  const guiClosed = !windows().includes(`"${guiTitle}"`);

  // 5. exports: the plugin in a stem render (cps 1: notes at 0 and 0.5 s of each cycle, with rests
  // between), freshly loaded (an export's instance starts as the live plugin is, and part 2 turned
  // its volume down)
  await page.evaluate((plugin) => unloadClap(plugin), PLUGIN);
  const exportCycles = 3;
  let exported;
  try {
    exported = await renderStemsInPage(
      page,
      () => stack(note("c4 ~ e4 ~").clap('Surge XT').orbit(2), note("c6").s('sine').decay(0.1).sustain(0).orbit(1)),
      { cps: 1, cycles: exportCycles, sampleRate: 48000 },
    );
  } catch (err) {
    exported = { error: String(err?.message ?? err) };
  }
  const exportExpected = Array.from({ length: exportCycles * 2 }, (_, k) => k * 0.5 * 48000);
  const exportStem = exported?.stems?.get(2);
  const exportOnsets = exportStem ? onsets(exportStem, 0.05 * peak(exportStem), 0.1 * 48000) : [];
  const exportOffsetsMs = exportExpected.map((at) => {
    const near = exportOnsets.reduce((best, o) => (Math.abs(o - at) < Math.abs(best - at) ? o : best), Infinity);
    return ((near - at) / 48000) * 1000;
  });
  const exportMaxMs = Math.max(...exportOffsetsMs.map(Math.abs));

  // 6. filters on the plugin's stream
  const renderPlugin = async (builder) => (await renderStemsInPage(page, builder, { cps: 1, cycles: 1, sampleRate: 48000 }))?.stems?.get(1);
  const brightness = (x, from = 0, to = x?.length ?? 0) => {
    let d = 0;
    for (let i = from + 1; i < to; i++) d += (x[i] - x[i - 1]) ** 2;
    return Math.sqrt(d / Math.max(1, to - from - 1)) / Math.max(1e-9, rmsOf(x, from, to));
  };
  let filterMetrics;
  try {
    const plain = await renderPlugin(() => note("c4 ~ e4 ~").clap('Surge XT'));
    const lpf = await renderPlugin(() => note("c4 ~ e4 ~").clap('Surge XT').lpf(300));
    const hpf = await renderPlugin(() => note("c4 ~ e4 ~").clap('Surge XT').hpf(3000));
    const env = await renderPlugin(() => note("c4 ~ e4 ~").clap('Surge XT').lpf(200).lpenv(6).lpattack(0.001).lpdecay(0.08).lpsustain(0));
    const db = (a, b) => 20 * Math.log10(a / b);
    filterMetrics = {
      lpfDarkerDb: db(brightness(plain), brightness(lpf)),
      hpfBrighterDb: db(brightness(hpf), brightness(plain)),
      // the first note: its first 40 ms against 150-240 ms
      envelopeDropDb: db(brightness(env, 0, 1920), brightness(env, 7200, 11520)),
    };
  } catch (err) {
    filterMetrics = { error: String(err?.message ?? err) };
  }

  // 7. state
  let stateMetrics;
  try {
    const rmsOfRender = async (state) => {
      const stem = await renderPlugin(
        state == null
          ? () => note("c4 ~ e4 ~").clap('Surge XT')
          : (0, eval)(`() => note("c4 ~ e4 ~").clap('Surge XT', { state: '${state}' })`),
      );
      return stem ? rmsOf(stem, 0, stem.length) : 0;
    };
    await page.evaluate((plugin) => unloadClap(plugin), PLUGIN);
    const played = await page.evaluate(playFor, { code: `note("c4").clap('${PLUGIN}')`, seconds: 1 });
    if (played.error) throw new Error(played.error);
    const defaultState = await page.evaluate((plugin) => clapState(plugin), PLUGIN);
    const muting = await page.evaluate(playFor, { code: `note("c4").clap('${PLUGIN}').auto(0, { c: 'Global Volume' })`, seconds: 1 });
    if (muting.error) throw new Error(muting.error);
    const mutedState = await page.evaluate((plugin) => clapState(plugin), PLUGIN);
    const liveRms = await rmsOfRender(null);
    const defaultRms = await rmsOfRender(defaultState);
    const mutedRms = await rmsOfRender(mutedState);
    stateMetrics = {
      chars: defaultState.length,
      prefix: defaultState.slice(0, 6),
      differs: defaultState !== mutedState,
      exportLikeLiveRms: liveRms,
      exportDefaultRms: defaultRms,
      exportMutedRms: mutedRms,
    };
  } catch (err) {
    stateMetrics = { error: String(err?.message ?? err) };
  }

  // 3. on a native output
  const native = await page.evaluate(playNative, { code: NATIVE_CODE, seconds: 3, plugin: PLUGIN, unload: false }, { timeoutMs: 120000 });
  // automation on the native output: the engine applies the parameter changes (counted). (Their
  // effect on the sound is checked in the mixer above and in the Rust tests; the silent test device
  // has no clock, so its capture can't show it.)
  const muted = await page.evaluate(playNative, { code: NATIVE_MUTED_CODE, seconds: 3, plugin: PLUGIN }, { timeoutMs: 120000 });
  const metrics = {
    pluginNotes: pluginOnsets.length,
    referenceNotes: referenceOnsets.length,
    syncOffsetsMs: offsetsMs.map((d) => +d.toFixed(2)),
    maxSyncOffsetMs: maxOffsetMs,
    pluginRms: rmsOf(plugin, 0, plugin.length),
    masterRms: rmsOf(master, 0, master.length),
    reverbTailGainDb: tailGainDb,
    automatableParams: paramNames.length,
    gui: { error: guiOpen.error, width: guiWidth, height: guiHeight, colours: guiColours, closed: guiClosed },
    automationDropDb,
    export: exported?.error
      ? { error: exported.error }
      : {
          orbits: exported ? [...exported.stems.keys()] : null,
          pluginStemNotes: exportOnsets.length,
          offsetsMs: exportOffsetsMs.map((d) => +d.toFixed(2)),
          sineStemRms: exported?.stems?.get(1) ? rmsOf(exported.stems.get(1), 0, exported.stems.get(1).length) : null,
          // where only the plugin sounds (its second note; the sine has decayed)
          sineStemLeakRms: exported?.stems?.get(1) ? rmsOf(exported.stems.get(1), 26400, 33600) : null,
        },
    filters: filterMetrics,
    state: stateMetrics,
    native: native.error
      ? { error: native.error }
      : {
          notes: native.stats.notes,
          lateNotes: native.stats.lateNotes,
          device: native.stats.device,
          rms: native.rms,
          paramChanges: muted.stats?.paramChanges,
          loadedAfterUnload: muted.loadedAfterUnload,
        },
    headline: `${PLUGIN} in the mixer: within ${maxOffsetMs.toFixed(1)} ms of the beat, room +${tailGainDb.toFixed(1)} dB, automation -${automationDropDb.toFixed(0)} dB, GUI ${guiWidth}x${guiHeight}, export ${exportOnsets.length} notes within ${exportMaxMs.toFixed(1)} ms, lpf -${filterMetrics.lpfDarkerDb?.toFixed(0)} dB; native: ${native.stats?.notes ?? 0} notes`,
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
  if (guiOpen.error) return fail(`GUI: ${guiOpen.error}`);
  if (!(guiWidth > 100 && guiHeight > 100)) return fail(`no "${guiTitle}" window of a usable size (${guiWidth}x${guiHeight})`);
  if (!(guiColours > 50)) return fail(`the GUI window shows ${guiColours} colours: not drawn`);
  if (!guiClosed) return fail('the GUI window was still open after clapGui(name, false)');
  if (!exported || exported.error) return fail(`export: ${exported?.error ?? 'no renderPatternStems in the page'}`);
  if (!exportStem) return fail(`export: no stem for the plugin's orbit 2 (stems: ${[...exported.stems.keys()]})`);
  if (exportOnsets.length !== exportExpected.length) return fail(`export: ${exportOnsets.length} plugin notes in its stem, expected ${exportExpected.length}`);
  if (!(exportMaxMs <= MAX_EXPORT_MS)) return fail(`export: plugin notes off their times by up to ${exportMaxMs.toFixed(2)} ms`);
  if (!(metrics.export.sineStemRms >= thresholds.minRms)) return fail('export: the sine stem is silent');
  if (!(metrics.export.sineStemLeakRms < 1e-3)) return fail(`export: the plugin is in the sine's stem too (rms ${metrics.export.sineStemLeakRms})`);
  if (filterMetrics.error) return fail(`filters: ${filterMetrics.error}`);
  if (!(filterMetrics.lpfDarkerDb >= 12)) return fail(`lpf(300) made the plugin only ${filterMetrics.lpfDarkerDb.toFixed(1)} dB darker`);
  if (!(filterMetrics.hpfBrighterDb >= 6)) return fail(`hpf(3000) made the plugin only ${filterMetrics.hpfBrighterDb.toFixed(1)} dB brighter`);
  if (!(filterMetrics.envelopeDropDb >= 6)) return fail(`the filter envelope darkened the note by only ${filterMetrics.envelopeDropDb.toFixed(1)} dB`);
  if (stateMetrics.error) return fail(`state: ${stateMetrics.error}`);
  if (stateMetrics.prefix !== 'clap1:' || !stateMetrics.differs) return fail('state: clapState gave no usable state, or the same one before and after muting');
  if (!(stateMetrics.exportDefaultRms >= thresholds.minRms)) return fail(`state: the export with the default state is silent (${stateMetrics.exportDefaultRms})`);
  if (!(stateMetrics.exportLikeLiveRms < stateMetrics.exportDefaultRms / 10)) return fail('state: the export did not start as the (muted) live plugin');
  if (!(stateMetrics.exportMutedRms < stateMetrics.exportDefaultRms / 10)) return fail('state: { state: muted } did not mute the export');
  if (native.error) return fail(`native output: ${native.error}`);
  if (!(native.stats.notes >= 11) || native.stats.lateNotes > 0) return fail(`native output: ${native.stats.notes} notes, ${native.stats.lateNotes} late`);
  if (!(native.rms >= thresholds.minRms)) return fail(`native output rms ${native.rms}`);
  if (native.stats.device !== 'strudel_null') return fail(`native output played on ${native.stats.device}`);
  if (muted.error) return fail(`native output, automated: ${muted.error}`);
  if (!(muted.stats.paramChanges > 0)) return fail('the native output applied no parameter changes for .auto()');
  if (muted.loadedAfterUnload.length) return fail(`still loaded after unloadClap: ${muted.loadedAfterUnload}`);
  return { status: 'pass', metrics, notes };
}
