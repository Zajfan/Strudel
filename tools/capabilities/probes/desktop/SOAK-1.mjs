// SOAK-1 (desktop): a long session, as a musician would have one: the app plays a pattern with
// superdough voices, a CLAP instrument, an effect plugin on an orbit and one on the master, for
// `minutes` (SOAK_MINUTES overrides the threshold), with a live edit every EDIT_MINUTES and an export
// every EXPORT_MINUTES (as the Export tab does it: stop, render the stems, start again). Every minute:
// - memory: resident memory of the app and its WebKit processes (all processes on the app's display);
//   checked: growth per hour after the first WARMUP_MINUTES, from a straight-line fit;
// - timing: an in-page detector logs the onset frame of each cycle's note on three orbits (a
//   superdough click, the plugin, an orbit through the effect); checked: drift, the change of each
//   orbit's offset from its cycle grid between the first and the last DRIFT_CYCLES cycles of each
//   playing stretch; jitter, the largest single offset (the plugin's own onsets vary ~2 ms);
// - dropouts: effect chunks played dry (fxStats), plugin notes too late to play, errors logged;
//   after the first minute (startup is PLUG-2's: the plugins load then);
// - exports: how long each took, and whether the plugin's stem came out the same each time.

import { readdirSync, readFileSync } from 'node:fs';

export const usesPage = true;

const PLUGIN = 'Surge XT';
const EFFECT = 'Surge XT Effects';
const EDIT_MINUTES = 5;
const EXPORT_MINUTES = 15;
const WARMUP_MINUTES = 10;
const CPS = 0.5;
const DRIFT_CYCLES = 20;

// a session: the three measured orbits, and the rest of a track around them; `variant` is what the
// live edits change
const code = (variant) => `setcps(${CPS})
$: note("c6 ~ ~ ~").s("sine").decay(0.03).sustain(0).gain(0.5).orbit(1)
$: note("c3 ~ ~ ~").clap('${PLUGIN}', { id: 'soak-synth' }).orbit(2)
$: note("e6 ~ ~ ~").s("sine").decay(0.03).sustain(0).gain(0.5).orbit(3).clapfx('${EFFECT}', { id: 'soak-fx' })
$: s("hh*${8 + (variant % 3) * 4}").gain(0.2).orbit(4)
$: note("<c3 e3 g3 b3>*4").s("sawtooth").lpf(sine.range(${300 + variant * 50}, 2000).slow(4)).gain(0.2).orbit(5)
$: s("bd*2").gain(0.3).orbit(6).room(0.${(variant % 5) + 2})
masterfx('${EFFECT}', { id: 'soak-master' })`;

// Runs in the page: plays the code and logs onsets on orbits 1-3 (after their inserts). An onset is
// where a fast envelope (~1 ms) jumps above 4x a slow one (~50 ms) and a floor (`thresholds`), at
// most one per 0.5 s: a click stands out over the tail of the one before (an effect's, say).
async function startSession({ code, thresholds }) {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const controller = getSuperdoughAudioController();
  const taps = [1, 2, 3].map((n) => controller.getOrbit(n, [0, 1]).post);
  window.__soakCount = (window.__soakCount ?? 0) + 1;
  const name = `soak-onsets-${window.__soakCount}`;
  const source = `
    class D extends AudioWorkletProcessor {
      constructor() {
        super();
        this.thresholds = ${JSON.stringify(thresholds)};
        this.fast = this.thresholds.map(() => 0);
        this.slow = this.thresholds.map(() => 0);
        this.since = this.thresholds.map(() => 1e9);
        this.onsets = this.thresholds.map(() => []);
        this.port.onmessage = () => {
          this.port.postMessage(this.onsets);
          this.onsets = this.thresholds.map(() => []);
        };
      }
      process(inputs) {
        const af = 1 - Math.exp(-1 / (0.001 * sampleRate));
        const as = 1 - Math.exp(-1 / (0.05 * sampleRate));
        inputs.forEach((input, k) => {
          const x = input[0];
          for (let i = 0; i < 128; i++) {
            const v = x ? Math.abs(x[i]) : 0;
            this.fast[k] += af * (v - this.fast[k]);
            const before = this.slow[k];
            this.slow[k] += as * (v - this.slow[k]);
            this.since[k]++;
            if (this.fast[k] > this.thresholds[k] && this.fast[k] > 4 * before && this.since[k] > 0.5 * sampleRate) {
              this.onsets[k].push(currentFrame + i);
              this.since[k] = 0;
            }
          }
        });
        return true;
      }
    }
    registerProcessor('${name}', D);`;
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const detector = new AudioWorkletNode(ctx, name, { numberOfInputs: 3, numberOfOutputs: 1 });
  const sink = new GainNode(ctx, { gain: 0 });
  taps.forEach((tap, k) => tap.connect(detector, 0, k));
  detector.connect(sink).connect(ctx.destination);
  window.__soakDetector = detector;
  window.__soakErrors ??= 0;
  if (!window.__soakErrorListener) {
    window.__soakErrorListener = (e) => {
      if (e.detail?.type === 'error') window.__soakErrors++;
    };
    document.addEventListener('strudel.log', window.__soakErrorListener);
  }
  const m = window.strudelMirror;
  m.setCode(code);
  await m.evaluate();
  return { error: String(m.repl.state.error || '') || undefined, sampleRate: ctx.sampleRate };
}

// Runs in the page: the onsets since the last sample, and the counters.
async function sample({ code }) {
  const detector = window.__soakDetector;
  const onsets = detector
    ? await new Promise((resolve) => {
        detector.port.onmessage = (e) => resolve(e.data);
        detector.port.postMessage('dump');
      })
    : [[], [], []];
  let error;
  if (code) {
    const m = window.strudelMirror;
    m.setCode(code);
    await m.evaluate();
    error = String(m.repl.state.error || '') || undefined;
  }
  const mix = await window.__TAURI_INTERNALS__.invoke('mix_stats');
  return { onsets, fxStats: fxStats(), lateNotes: mix.lateNotes, errors: window.__soakErrors ?? 0, error };
}

// Runs in the page: an export as the Export tab does it (stop, render, set up audio again), then the
// session starts again (startSession). Returns how long the render took and the plugin stem's rms.
async function exportStems({ cycles }) {
  const m = window.strudelMirror;
  window.__soakDetector?.disconnect();
  await m.evaluate(false);
  m.repl.scheduler.stop();
  const { pattern } = m.repl.state;
  const { cps } = m.repl.scheduler;
  const t0 = performance.now();
  let result;
  try {
    const { stems } = await renderPatternStems(pattern, cps, 0, cycles, 44100, 128);
    const stem = stems.get(2);
    let sum = 0;
    const left = stem ? stem.getChannelData(0) : new Float32Array(1);
    for (const x of left) sum += x * x;
    result = { ms: performance.now() - t0, pluginRms: Math.sqrt(sum / left.length), orbits: [...stems.keys()] };
  } catch (err) {
    result = { error: String(err) };
  }
  await initAudio({});
  return result;
}

// resident memory (MB) of the processes on the app's display, by name
function memory(display) {
  const byName = {};
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
      if (!environ.split('\0').includes(`DISPLAY=${display}`)) continue;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const name = status.match(/^Name:\s+(.+)$/m)?.[1] ?? pid;
      const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) / 1024;
      byName[name] = (byName[name] ?? 0) + rss;
    } catch {
      // gone, or not ours
    }
  }
  return byName;
}

// slope (per hour) of a straight-line fit of [minute, value]
function slopePerHour(points) {
  if (points.length < 3) return 0;
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return sxx ? (sxy / sxx) * 60 : 0;
}

// how far each onset strays from the cycle grid of its stretch (ms), against the grid's median phase
// (a stray onset doesn't move the grid)
function gridErrors(onsets, period, sr) {
  if (onsets.length < 2) return [];
  const phase = (o) => ((o % period) + period) % period;
  const phases = onsets.map(phase).sort((a, b) => a - b);
  const median = phases[phases.length >> 1];
  return onsets.map((o) => {
    let d = phase(o) - median;
    if (d > period / 2) d -= period;
    if (d < -period / 2) d += period;
    return (d / sr) * 1000;
  });
}

export async function probe({ page, thresholds, log = () => {} }) {
  const minutes = Number(process.env.SOAK_MINUTES ?? thresholds.minutes ?? 120);
  const notes = { minutes, code: code(0), editEveryMinutes: EDIT_MINUTES, exportEveryMinutes: EXPORT_MINUTES };
  const plugins = await page.evaluate(() => window.__TAURI_INTERNALS__?.invoke('clap_plugins') ?? null);
  if (!plugins?.includes(PLUGIN) || !plugins.includes(EFFECT)) {
    return { status: 'not-run', metrics: { plugins }, notes: { ...notes, reason: `${PLUGIN} and ${EFFECT} are needed in a CLAP folder (see the follow-ups doc)` } };
  }
  // (the effect turns orbit 3's click into a quieter echo, ~0.07 peak)
  const detectorThresholds = [0.05, 0.01, 0.01];
  const started = await page.evaluate(startSession, { code: code(0), thresholds: detectorThresholds });
  if (started.error) return { status: 'fail', metrics: {}, notes: { ...notes, error: started.error } };
  const sr = started.sampleRate;
  const period = Math.round(sr / CPS);

  // per stretch of playing (exports restart the audio clock): onsets per orbit
  const stretches = [[[], [], []]];
  const timeline = [];
  const exportsDone = [];
  let variant = 0;
  let lastFx = {};
  let firstMem;
  let lastMem;
  const t0 = Date.now();
  for (let minute = 1; minute <= minutes; minute++) {
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + minute * 60000 - Date.now())));
    const edit = minute % EDIT_MINUTES === 0 && minute % EXPORT_MINUTES !== 0;
    if (edit) variant++;
    const s = await page.evaluate(sample, { code: edit ? code(variant) : undefined }, { timeoutMs: 120000 });
    s.onsets.forEach((list, k) => stretches.at(-1)[k].push(...list));
    const mem = memory(page.display);
    if (minute === 1) firstMem = mem;
    lastMem = mem;
    const totalMb = Object.values(mem).reduce((a, b) => a + b, 0);
    const lateFrames = Object.entries(s.fxStats)
      .filter(([k]) => k !== 'roundTripsMs')
      .reduce((n, [, v]) => n + (v.lateFrames ?? 0), 0);
    lastFx = s.fxStats;
    timeline.push({ minute, memMb: +totalMb.toFixed(1), lateFrames, lateNotes: s.lateNotes, errors: s.errors, edit: edit || undefined, editError: s.error });
    log(`minute ${minute}: ${totalMb.toFixed(0)} MB, late frames ${lateFrames}, late notes ${s.lateNotes}, errors ${s.errors}${edit ? ', edited' : ''}`);
    if (minute % EXPORT_MINUTES === 0 && minute < minutes) {
      const out = await page.evaluate(exportStems, { cycles: 4 }, { timeoutMs: 600000 });
      exportsDone.push({ minute, ...out });
      log(`minute ${minute}: export ${out.error ?? `${out.ms.toFixed(0)} ms, plugin rms ${out.pluginRms.toFixed(4)}`}`);
      // fx stats start over with the new inserts; the session starts again
      const again = await page.evaluate(startSession, { code: code(variant), thresholds: detectorThresholds });
      if (again.error) timeline.at(-1).restartError = again.error;
      stretches.push([[], [], []]);
    }
  }

  // timing, per stretch
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
  const jitter = [0, 1, 2].map((k) => Math.max(0, ...stretches.flatMap((st) => gridErrors(st[k], period, sr).map(Math.abs))));
  const drift = [0, 1, 2].map((k) =>
    Math.max(
      0,
      ...stretches
        .map((st) => gridErrors(st[k], period, sr))
        .filter((e) => e.length >= 2 * DRIFT_CYCLES)
        .map((e) => Math.abs(median(e.slice(-DRIFT_CYCLES)) - median(e.slice(0, DRIFT_CYCLES)))),
    ),
  );
  // the plugin's and the effected orbit's onsets against the click's, per cycle (frames apart)
  const spread = [];
  for (const st of stretches) {
    for (const click of st[0]) {
      const near = (list) => list.reduce((best, x) => (Math.abs(x - click) < Math.abs(best - click) ? x : best), Infinity);
      const offsets = [near(st[1]) - click, near(st[2]) - click].map((d) => (d / sr) * 1000);
      if (offsets.every((d) => Math.abs(d) < 200)) spread.push(offsets);
    }
  }
  const spreadRange = (k) => (spread.length ? Math.max(...spread.map((o) => o[k])) - Math.min(...spread.map((o) => o[k])) : NaN);
  const warm = timeline.filter((p) => p.minute > Math.min(WARMUP_MINUTES, minutes / 2)).map((p) => [p.minute, p.memMb]);
  const memGrowth = slopePerHour(warm);
  // after the first minute; fx stats start over when an export restarts the audio
  const lateFrames = timeline.reduce((n, p, i) => (i === 0 ? 0 : n + (timeline[i - 1].lateFrames > p.lateFrames ? p.lateFrames : p.lateFrames - timeline[i - 1].lateFrames)), 0);
  const lateNotes = (timeline.at(-1)?.lateNotes ?? 0) - (timeline[0]?.lateNotes ?? 0);
  const pluginRms = exportsDone.filter((e) => !e.error).map((e) => e.pluginRms);
  const metrics = {
    minutes,
    memMb: { first: timeline[0]?.memMb, last: timeline.at(-1)?.memMb, growthPerHour: +memGrowth.toFixed(1) },
    onsets: [0, 1, 2].map((k) => stretches.reduce((n, st) => n + st[k].length, 0)),
    driftMs: drift.map((d) => +d.toFixed(3)),
    jitterMs: jitter.map((d) => +d.toFixed(3)),
    memByProcess: { first: firstMem, last: lastMem },
    spreadMs: { plugin: +spreadRange(0).toFixed(2), effect: +spreadRange(1).toFixed(2) },
    lateFrames,
    lateNotes,
    startup: { lateFrames: timeline[0]?.lateFrames, lateNotes: timeline[0]?.lateNotes },
    errors: timeline.at(-1)?.errors ?? 0,
    edits: timeline.filter((p) => p.edit).length,
    editErrors: timeline.filter((p) => p.editError || p.restartError).map((p) => p.editError ?? p.restartError),
    exports: exportsDone.map((e) => (e.error ? { minute: e.minute, error: e.error } : { minute: e.minute, ms: Math.round(e.ms), pluginRms: +e.pluginRms.toFixed(5) })),
    roundTripsMs: lastFx.roundTripsMs,
    timeline,
  };
  metrics.headline = `${minutes} min: memory ${metrics.memMb.first?.toFixed(0)} -> ${metrics.memMb.last?.toFixed(0)} MB (${memGrowth.toFixed(0)} MB/h), drift ${Math.max(...drift).toFixed(2)} ms, plugin spread ${metrics.spreadMs.plugin} ms, ${lateFrames} late frames, ${metrics.errors} errors, ${exportsDone.length} exports`;
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  const expected = minutes * 60 * CPS * 0.8;
  if (metrics.onsets.some((n) => n < expected)) return fail(`too few onsets (${metrics.onsets}; expected about ${Math.round(expected / 0.8)} each)`);
  if (!(Math.max(...drift) <= thresholds.maxDriftMs)) return fail(`timing drifted by up to ${Math.max(...drift).toFixed(2)} ms over a stretch`);
  if (!(jitter[0] <= thresholds.maxDriftMs && jitter[2] <= thresholds.maxDriftMs && jitter[1] <= thresholds.maxSpreadMs)) return fail(`a note was off its cycle grid by ${Math.max(...jitter).toFixed(2)} ms`);
  if (!(spreadRange(0) <= thresholds.maxSpreadMs && spreadRange(1) <= thresholds.maxSpreadMs)) return fail(`the plugin or effect moved against the click by up to ${Math.max(spreadRange(0), spreadRange(1)).toFixed(2)} ms`);
  if (!(memGrowth <= thresholds.maxMemGrowthMbPerHour)) return fail(`memory grew ${memGrowth.toFixed(0)} MB per hour`);
  if (lateFrames > thresholds.maxLateFrames) return fail(`${lateFrames} effect frames came back too late`);
  if (metrics.lateNotes > 0) return fail(`${metrics.lateNotes} plugin notes came too late to play`);
  if (metrics.errors > 0) return fail(`${metrics.errors} errors logged`);
  if (metrics.editErrors.length) return fail(`edits failed: ${metrics.editErrors[0]}`);
  const exportError = exportsDone.find((e) => e.error);
  if (exportError) return fail(`export at minute ${exportError.minute}: ${exportError.error}`);
  if (pluginRms.length > 1 && Math.max(...pluginRms) - Math.min(...pluginRms) > 0.05 * Math.max(...pluginRms)) return fail(`the plugin's stem differed between exports (rms ${pluginRms})`);
  return { status: 'pass', metrics, notes };
}
