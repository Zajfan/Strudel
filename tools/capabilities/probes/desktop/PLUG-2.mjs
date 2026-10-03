// PLUG-2 (desktop): mixing with plugins, beyond one instrument per plugin (PLUG-1).
// 1. Instances: two Surge XTs by id ('bass', 'lead') in one stem render, bass with its volume
//    automated to 0: the bass stem must be silent and the lead stem not (each instance has its own
//    settings); played live, both are loaded under their ids.
// 2. Effects, live: a short sine on orbit 2 with .clapfx('Surge XT Effects') (its default effect has
//    a tail), the same on orbit 3 without, and masterfx on the master; taps after orbit 2's insert,
//    on orbit 3 and after the master's insert. Checked: orbit 2's notes start within MAX_SYNC_MS of
//    orbit 3's (the insert's latency is compensated), it has a tail and orbit 3 none, the master's
//    output is one insert latency after the orbits, no chunk came back from Rust too late, and code
//    without clapfx/masterfx removes the inserts (latency 0).
// 3. Effects in exports: the same pattern (and a Surge XT instrument through the effect) as stems:
//    orbit 2's stem has the tail, orbit 3's not; and a chain that changes during the song (the
//    effect in cycle 0, clapfx(null) in cycle 1) is followed.
// 4. VST3 (Surge XT's VST3 build, by { format: 'vst3' }): live in the mixer, its notes within
//    MAX_VST3_MS of a reference superdough note; an export with a VST3 effect on an orbit has the
//    effect's tail in that orbit's stem; its state is text that starts with "vst3:"; its editor
//    opens in a window that shows something, and closes; it plays on the native output too.
// Without Surge XT in a CLAP folder this is not-run (see the follow-ups doc for installing it).

import { execFileSync } from 'node:child_process';
import { renderStemsInPage } from '../../lib/browser/page-render.mjs';

export const usesPage = true;

const PLUGIN = 'Surge XT';
const PENDING = [];
// Surge XT's notes start up to ~2 ms late at 48 kHz (its 16-frame blocks and attack), as in PLUG-1
const MAX_VST3_MS = 3;
const VST3_CODE =
  `setcps(1)\n$: note("c4 ~ ~ ~").clap('${PLUGIN}', { format: 'vst3', id: 'v3' }).orbit(2)\n` +
  `$: note("c6 ~ ~ ~").s("sine").gain(0.3).release(0.05).orbit(3)`;
const EFFECT = 'Surge XT Effects';
const MAX_SYNC_MS = 2;
const FX_CODE =
  `setcps(1)\n$: note("c5 ~ ~ ~").s("sine").decay(0.05).sustain(0).orbit(2).clapfx('${EFFECT}')\n` +
  `$: note("g5 ~ ~ ~").s("sine").decay(0.05).sustain(0).orbit(3)\n` +
  `masterfx('${EFFECT}', { id: 'mfx' })`;
const NO_FX_CODE = `setcps(1)\n$: note("c5 ~ ~ ~").s("sine").decay(0.05).sustain(0).orbit(2)`;
const INSTANCES_CODE =
  `setcps(1)\n$: note("c3 ~ ~ ~").clap('${PLUGIN}', { id: 'bass' }).auto(0, { c: 'Global Volume' })\n` +
  `$: note("e4 ~ ~ ~").clap('${PLUGIN}', { id: 'lead' }).orbit(2)`;

// Runs in the page; serialized with toString(), so no closures over Node scope.
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

// Records taps while code plays: 'orbit:<n>' (after the orbit's insert) or 'master' (after the
// master's insert). Runs in the page.
async function recordTaps({ code, seconds, taps }) {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const controller = getSuperdoughAudioController();
  const nodes = taps.map((tap) => (tap === 'master' ? controller.output.masterOut : controller.getOrbit(Number(tap.split(':')[1]), [0, 1]).post));
  window.__capsTapCount = (window.__capsTapCount ?? 0) + 1;
  const name = `caps-plug2-recorder-${window.__capsTapCount}`;
  const source = `
    class R extends AudioWorkletProcessor {
      constructor() { super(); this.chunks = ${JSON.stringify(taps)}.map(() => []); this.on = true;
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
  const recorder = new AudioWorkletNode(ctx, name, { numberOfInputs: taps.length, numberOfOutputs: 1 });
  const sink = new GainNode(ctx, { gain: 0 });
  nodes.forEach((node, k) => node.connect(recorder, 0, k));
  recorder.connect(sink).connect(ctx.destination);
  const m = window.strudelMirror;
  let recorded;
  let latency;
  try {
    m.setCode(code);
    await m.evaluate();
    const error = String(m.repl.state.error || '');
    if (error) return { error };
    await new Promise((r) => setTimeout(r, seconds * 1000));
    latency = { orbit2: controller.latency(2), master: controller.output.inserts.latency };
    recorded = await new Promise((resolve) => {
      recorder.port.onmessage = (e) => resolve(e.data);
      recorder.port.postMessage('dump');
    });
  } finally {
    m.stop();
    nodes.forEach((node) => node.disconnect(recorder));
    recorder.disconnect();
    sink.disconnect();
  }
  const b64 = (samples) => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  return { sampleRate: ctx.sampleRate, latency, fxStats: fxStats(), recorded: recorded.map(b64) };
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
const peak = (xs) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const rmsRange = (x, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};
// the rms over the part of each cycle from `from` to `to` seconds after its first onset
function tailRms(x, starts, sr, from, to) {
  const parts = starts.filter((s) => s + to * sr <= x.length).map((s) => rmsRange(x, s + Math.round(from * sr), s + Math.round(to * sr)));
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
}

const rmsOf = (samples) => {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / Math.max(1, samples.length));
};

export async function probe({ page, thresholds }) {
  const notes = { plugin: PLUGIN, instances: INSTANCES_CODE };
  if (thresholds.minRms == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold minRms missing' } };
  const plugins = await page.evaluate(() => window.__TAURI_INTERNALS__?.invoke('clap_plugins') ?? null);
  if (!plugins?.includes(PLUGIN)) {
    return { status: 'not-run', metrics: { plugins }, notes: { ...notes, reason: `${PLUGIN} not installed in a CLAP folder (see the follow-ups doc)` } };
  }

  // 1. instances
  let instances;
  try {
    const out = await renderStemsInPage(
      page,
      () =>
        stack(
          // (pure: the render's scope parses every string as mini-notation, which would split the name)
          note("c3 ~ ~ ~").clap('Surge XT', { id: 'bass' }).auto(0, { c: pure('Global Volume') }),
          note("e4 ~ ~ ~").clap('Surge XT', { id: 'lead' }).orbit(2),
        ),
      { cps: 1, cycles: 2, sampleRate: 48000 },
    );
    const live = await page.evaluate(playFor, { code: INSTANCES_CODE, seconds: 1.5 });
    if (live.error) throw new Error(live.error);
    const loaded = await page.evaluate(() => loadedClaps());
    const bassParams = await page.evaluate(async () => (await clapParams('bass')).length);
    await page.evaluate(async () => {
      await unloadClap('bass');
      await unloadClap('lead');
    });
    instances = {
      bassStemRms: rmsOf(out.stems.get(1) ?? []),
      leadStemRms: rmsOf(out.stems.get(2) ?? []),
      loaded,
      bassParams,
    };
  } catch (err) {
    instances = { error: String(err?.message ?? err) };
  }

  // 2. effects, live
  let effects;
  try {
    if (!plugins.includes(EFFECT)) throw new Error(`${EFFECT} not installed in a CLAP folder`);
    const out = await page.evaluate(recordTaps, { code: FX_CODE, seconds: 5, taps: ['orbit:2', 'orbit:3', 'master'] }, { timeoutMs: 120000 });
    if (out.error) throw new Error(out.error);
    const [fx, dry, master] = out.recorded.map(decode);
    const sr = out.sampleRate;
    const gap = Math.round(0.5 * sr);
    const fxOnsets = onsets(fx, 0.2 * peak(fx), gap);
    const dryOnsets = onsets(dry, 0.2 * peak(dry), gap);
    // (the master carries both effects' tails: a shorter gap between its notes)
    const masterOnsets = onsets(master, 0.2 * peak(master), Math.round(0.2 * sr));
    const nearest = (xs, at) => xs.reduce((best, x) => (Math.abs(x - at) < Math.abs(best - at) ? x : best), Infinity);
    const syncMs = dryOnsets.map((d) => ((nearest(fxOnsets, d) - d) / sr) * 1000).filter((d) => Math.abs(d) < 100);
    const masterLagMs = dryOnsets.map((d) => ((nearest(masterOnsets, d) - d) / sr) * 1000).filter((d) => Math.abs(d) < 200);
    const live = await page.evaluate(playFor, { code: NO_FX_CODE, seconds: 1 });
    const latencyAfter = await page.evaluate(() => ({ orbit2: getSuperdoughAudioController().latency(2), master: getSuperdoughAudioController().output.inserts.latency }));
    effects = {
      insertLatencyMs: out.latency.master * 1000,
      orbit2LatencyMs: out.latency.orbit2 * 1000,
      notes: { fx: fxOnsets.length, dry: dryOnsets.length },
      syncMs: syncMs.map((d) => +d.toFixed(2)),
      masterLagMs: masterLagMs.map((d) => +d.toFixed(2)),
      tail: { fx: tailRms(fx, fxOnsets, sr, 0.3, 0.6), dry: tailRms(dry, dryOnsets, sr, 0.3, 0.6) },
      fxStats: out.fxStats,
      liveError: live.error,
      latencyAfterRemoval: latencyAfter,
    };
  } catch (err) {
    effects = { error: String(err?.message ?? err) };
  }

  // 3. effects in exports
  let exported;
  try {
    const out = await renderStemsInPage(
      page,
      () =>
        stack(
          note("c5 ~ ~ ~").s('sine').decay(0.05).sustain(0).orbit(2).clapfx('Surge XT Effects'),
          note("c3 ~ ~ ~").clap('Surge XT').orbit(2).clapfx('Surge XT Effects'),
          note("g5 ~ ~ ~").s('sine').decay(0.05).sustain(0).orbit(3),
        ),
      { cps: 1, cycles: 2, sampleRate: 48000 },
    );
    const [two, three] = [out.stems.get(2), out.stems.get(3)];
    exported = {
      orbits: [...out.stems.keys()],
      tail: { fx: rmsRange(two, 48000 * 1.5, 48000 * 1.9), dry: rmsRange(three, 48000 * 0.3, 48000 * 0.9) },
      fxRms: rmsOf(two),
    };
    // a chain that changes during the song: the effect in cycle 0, none (clapfx(null)) in cycle 1
    const changing = await renderStemsInPage(
      page,
      () => {
        const ping = note("c5 ~ ~ ~").s('sine').decay(0.05).sustain(0).orbit(2);
        return cat(ping.clapfx('Surge XT Effects'), ping.clapfx(null));
      },
      { cps: 1, cycles: 2, sampleRate: 48000 },
    );
    const stem = changing.stems.get(2);
    exported.changing = { withFx: rmsRange(stem, 48000 * 0.3, 48000 * 0.9), withoutFx: rmsRange(stem, 48000 * 1.3, 48000 * 1.9) };
  } catch (err) {
    exported = { error: String(err?.message ?? err) };
  }

  // 4. VST3
  let vst3;
  try {
    const out = await page.evaluate(recordTaps, { code: VST3_CODE, seconds: 4, taps: ['orbit:2', 'orbit:3'] }, { timeoutMs: 120000 });
    if (out.error) throw new Error(out.error);
    const [synth, reference] = out.recorded.map(decode);
    const sr = out.sampleRate;
    const gap = Math.round(0.5 * sr);
    const synthOnsets = onsets(synth, 0.05 * peak(synth), gap);
    const refOnsets = onsets(reference, 0.05 * peak(reference), gap);
    const nearest = (xs, at) => xs.reduce((best, x) => (Math.abs(x - at) < Math.abs(best - at) ? x : best), Infinity);
    const syncMs = refOnsets.map((r) => ((nearest(synthOnsets, r) - r) / sr) * 1000).filter((d) => Math.abs(d) < 100);
    const state = await page.evaluate(() => clapState('v3'));
    const title = 'v3: Surge XT - Strudel';
    const windows = () => execFileSync('xwininfo', ['-display', page.display, '-root', '-tree'], { encoding: 'utf8' });
    const guiOpen = await page.evaluate(async () => {
      try {
        await clapGui('v3');
        await new Promise((r) => setTimeout(r, 3000));
        return {};
      } catch (err) {
        return { error: String(err) };
      }
    });
    const guiLine = guiOpen.error ? undefined : windows().split('\n').find((l) => l.includes(`"${title}"`));
    const guiId = guiLine?.trim().split(' ')[0];
    const [width, height] = (guiLine?.match(/(\d+)x(\d+)\+/) ?? []).slice(1).map(Number);
    const colours = guiId
      ? Number(execFileSync('convert', ['-', '-format', '%k', 'info:'], { input: execFileSync('import', ['-display', page.display, '-window', guiId, 'png:-']) }).toString())
      : 0;
    await page.evaluate(() => clapGui('v3', false));
    await new Promise((r) => setTimeout(r, 500));
    const guiClosed = !windows().includes(`"${title}"`);
    await page.evaluate(() => unloadClap('v3'));
    // on the native output (the harness's silent device)
    const native = await page.evaluate(async (code) => {
      const T = window.__TAURI_INTERNALS__;
      await setPluginDevice('strudel_null');
      const m = window.strudelMirror;
      try {
        m.setCode(code);
        await m.evaluate();
        const error = String(m.repl.state.error || '');
        if (error) return { error };
        await new Promise((r) => setTimeout(r, 3000));
      } finally {
        m.stop();
      }
      const stats = await T.invoke('engine_stats');
      await unloadClap('vn');
      return { stats };
    }, `setcps(1)\nnote("c4 e4 g4 c5").clap('${PLUGIN}', { format: 'vst3', output: 'native', id: 'vn' })`);
    const rendered = await renderStemsInPage(
      page,
      () =>
        stack(
          note("c5 ~ ~ ~").s('sine').decay(0.05).sustain(0).orbit(2).clapfx('Surge XT Effects', { format: 'vst3' }),
          note("g5 ~ ~ ~").s('sine').decay(0.05).sustain(0).orbit(3),
        ),
      { cps: 1, cycles: 2, sampleRate: 48000 },
    );
    vst3 = {
      notes: synthOnsets.length,
      syncMs: syncMs.map((d) => +d.toFixed(2)),
      statePrefix: state.slice(0, 5),
      stateChars: state.length,
      gui: { error: guiOpen.error, width, height, colours, closed: guiClosed },
      native: native.error ? { error: native.error } : { notes: native.stats.notes, lateNotes: native.stats.lateNotes, lateBlocks: native.stats.lateBlocks, plugins: native.stats.plugins },
      exportTail: { fx: rmsRange(rendered.stems.get(2), 48000 * 1.5, 48000 * 1.9), dry: rmsRange(rendered.stems.get(3), 48000 * 0.3, 48000 * 0.9) },
    };
  } catch (err) {
    vst3 = { error: String(err?.message ?? err) };
  }

  const metrics = {
    instances,
    vst3,
    effects,
    export: exported,
    pending: PENDING,
    headline: instances.error
      ? `instances: ${instances.error}`
      : `2 instances; effects ${effects.error ? 'error' : `within ${Math.max(...(effects.syncMs ?? [NaN]).map(Math.abs)).toFixed(1)} ms after a ${effects.insertLatencyMs?.toFixed(0)} ms insert`}; VST3 ${vst3.error ? 'error' : `within ${Math.max(...vst3.syncMs.map(Math.abs)).toFixed(1)} ms, GUI ${vst3.gui.width}x${vst3.gui.height}`}${PENDING.length ? `; to do: ${PENDING.join(', ')}` : ''}`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (instances.error) return fail(`instances: ${instances.error}`);
  if (!(instances.leadStemRms >= thresholds.minRms)) return fail(`the lead instance is silent (${instances.leadStemRms})`);
  if (!(instances.bassStemRms < instances.leadStemRms / 10)) return fail("muting the bass instance's volume reached the lead instance (or didn't apply)");
  if (!(instances.loaded.includes('bass') && instances.loaded.includes('lead'))) return fail(`live: loaded instances ${instances.loaded}`);
  if (!(instances.bassParams > 0)) return fail('clapParams(id) listed no parameters');
  if (effects.error) return fail(`effects: ${effects.error}`);
  if (Math.abs(effects.insertLatencyMs - effects.orbit2LatencyMs / 2) > 0.01) return fail(`orbit 2's latency ${effects.orbit2LatencyMs} ms is not its insert's plus the master's`);
  if (!(effects.notes.fx >= 3 && effects.syncMs.length >= 3)) return fail(`effects: ${effects.notes.fx} notes after the insert, ${effects.syncMs.length} matched`);
  if (!(Math.max(...effects.syncMs.map(Math.abs)) <= MAX_SYNC_MS)) return fail(`effects: notes after the insert off by up to ${Math.max(...effects.syncMs.map(Math.abs)).toFixed(2)} ms`);
  if (!(effects.tail.fx > 10 * effects.tail.dry && effects.tail.fx >= thresholds.minRms)) return fail(`effects: no tail on the effect's orbit (${effects.tail.fx} vs ${effects.tail.dry})`);
  const lagOff = effects.masterLagMs.map((d) => Math.abs(d - effects.insertLatencyMs));
  if (!(effects.masterLagMs.length >= 3 && Math.max(...lagOff) <= MAX_SYNC_MS)) return fail(`effects: the master is not one insert latency (${effects.insertLatencyMs.toFixed(1)} ms) after the orbits: ${effects.masterLagMs}`);
  const late = Object.values(effects.fxStats ?? {}).reduce((n, s) => n + (s.lateFrames ?? 0), 0);
  if (late > 0) return fail(`effects: ${late} frames came back from Rust too late (played dry)`);
  if (effects.liveError) return fail(`effects: ${effects.liveError}`);
  if (effects.latencyAfterRemoval.orbit2 !== 0 || effects.latencyAfterRemoval.master !== 0) return fail('effects: code without clapfx/masterfx left an insert in place');
  if (exported.error) return fail(`effects in exports: ${exported.error}`);
  if (!(exported.tail.fx > 10 * exported.tail.dry && exported.tail.fx >= thresholds.minRms)) return fail(`effects in exports: no tail in orbit 2's stem (${exported.tail.fx} vs ${exported.tail.dry})`);
  if (vst3.error) return fail(`VST3: ${vst3.error}`);
  if (!(vst3.notes >= 3 && vst3.syncMs.length >= 3)) return fail(`VST3: ${vst3.notes} notes, ${vst3.syncMs.length} matched the reference`);
  if (!(Math.max(...vst3.syncMs.map(Math.abs)) <= MAX_VST3_MS)) return fail(`VST3: notes off the reference by up to ${Math.max(...vst3.syncMs.map(Math.abs)).toFixed(2)} ms`);
  if (vst3.native.error) return fail(`VST3 on the native output: ${vst3.native.error}`);
  if (!(vst3.native.notes >= 8)) return fail(`VST3 on the native output: ${vst3.native.notes} notes played`);
  if (vst3.statePrefix !== 'vst3:') return fail(`VST3: the state starts with ${vst3.statePrefix}`);
  if (vst3.gui.error) return fail(`VST3 GUI: ${vst3.gui.error}`);
  if (!(vst3.gui.width > 100 && vst3.gui.height > 100 && vst3.gui.colours > 50)) return fail(`VST3 GUI: ${vst3.gui.width}x${vst3.gui.height}, ${vst3.gui.colours} colours`);
  if (!vst3.gui.closed) return fail('VST3 GUI: still open after clapGui(name, false)');
  if (!(vst3.exportTail.fx > 10 * vst3.exportTail.dry && vst3.exportTail.fx >= thresholds.minRms)) return fail(`VST3 effect in an export: no tail (${vst3.exportTail.fx} vs ${vst3.exportTail.dry})`);
  if (!(exported.changing.withFx >= thresholds.minRms && exported.changing.withoutFx < exported.changing.withFx / 100)) {
    return fail(`effects in exports: a chain change during the song wasn't followed (${exported.changing.withFx} with, ${exported.changing.withoutFx} without)`);
  }
  if (PENDING.length) return fail(`not built yet: ${PENDING.join(', ')}`);
  return { status: 'pass', metrics, notes };
}
