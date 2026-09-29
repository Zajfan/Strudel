// PERF-1 (browser): V voices sound continuously for 60 s with 0 late starts and no silent RMS
// window. Instruments AudioScheduledSourceNode.prototype.start (when vs. context.currentTime) and
// taps an AnalyserNode onto whatever connects to context.destination (same technique as the
// (uncommitted) tools/baseline/browser-instrumentation.js probe, reimplemented here since that file
// isn't part of this repo's history).
//
// Only OscillatorNode/AudioBufferSourceNode starts are scored for lateness. superdough's own
// webAudioTimeout() hack (packages/superdough/helpers.mjs) schedules a cleanup ConstantSourceNode
// with `.start(0)` on every single note release (see superdough.mjs's onEnded / Orbit.duck) -
// that is a deliberate "start immediately" call, not a sign of audio-thread lateness, and
// including it made every run report thousands of false "late" starts. The same
// ConstantSourceNode/zeroGain hack also connects straight to context.destination once per note
// release, so the AnalyserNode tap is likewise limited to the first (persistent, master-bus)
// connection instead of re-tapping on every one of those.
async function playAndMeasure(V) {
  // Constants are inlined (not module-level) because ctx.page.evaluate stringifies only this
  // function; it has no closure over the rest of the module.
  const RUN_MS = 60000;
  const SAMPLE_MS = 250;
  const protoStart = AudioScheduledSourceNode.prototype.start;
  const protoConnect = AudioNode.prototype.connect;
  const starts = [];
  const analysers = [];
  let tapped = false;
  AudioScheduledSourceNode.prototype.start = function (when = 0, ...rest) {
    if (this instanceof OscillatorNode || this instanceof AudioBufferSourceNode) {
      starts.push({ when, now: this.context.currentTime });
    }
    return protoStart.call(this, when, ...rest);
  };
  AudioNode.prototype.connect = function (destination, ...rest) {
    if (!tapped && destination instanceof AudioDestinationNode) {
      tapped = true;
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 2048;
      protoConnect.call(this, analyser);
      analysers.push(analyser);
    }
    return protoConnect.call(this, destination, ...rest);
  };
  let interval;
  try {
    const m = window.strudelMirror;
    m.setCode(
      `setcps(0.5)\nstack(...Array.from({ length: ${V} }, (_, k) => note(36 + (k % 48)))).s('sawtooth').lpf(2000).attack(0.01).release(0.05).clip(1).gain(0.2 / ${V})`,
    );
    await m.evaluate();
    const rms = [];
    const buf = new Float32Array(2048);
    const testStart = performance.now();
    interval = setInterval(() => {
      if (analysers.length === 0) {
        rms.push(0);
        return;
      }
      let peak = 0;
      for (const a of analysers) {
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const r = Math.sqrt(sum / buf.length);
        if (r > peak) peak = r;
      }
      rms.push(peak);
    }, SAMPLE_MS);
    await new Promise((r) => setTimeout(r, RUN_MS));
    clearInterval(interval);
    const durationS = (performance.now() - testStart) / 1000;
    const error = String(m.repl.state.error || '');
    m.stop();
    const late = starts.filter((s) => s.when < s.now).length;
    const minLeadMs = starts.length ? Math.min(...starts.map((s) => (s.when - s.now) * 1000)) : null;
    const silentWindows = rms.filter((v, i) => (i * SAMPLE_MS) / 1000 >= 1 && v === 0).length;
    return {
      error,
      starts: starts.length,
      late,
      minLeadMs,
      silentWindows,
      durationS,
      analyserCount: analysers.length,
      rmsSamples: rms.length,
    };
  } finally {
    clearInterval(interval);
    AudioScheduledSourceNode.prototype.start = protoStart;
    AudioNode.prototype.connect = protoConnect;
  }
}

export async function probe({ page, thresholds }) {
  const notes = {
    scope: 'headless Chromium, fake audio device: measures scheduling lateness and rendered signal, not DAC underruns',
  };
  const V = thresholds.minVoices;
  if (V == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold minVoices missing' } };

  const result = await page.evaluate(playAndMeasure, V, { timeoutMs: 90000 });
  const metrics = {
    voices: V,
    starts: result.starts,
    late: result.late,
    minLeadMs: result.minLeadMs,
    silentWindows: result.silentWindows,
    durationS: result.durationS,
    analyserCount: result.analyserCount,
    headline: `${V} voices, ${result.late} late, ${result.silentWindows} silent windows`,
  };
  if (result.error) return { status: 'fail', metrics, notes: { ...notes, error: result.error } };
  if (page.errors.length) return { status: 'fail', metrics, notes: { ...notes, error: page.errors.slice(0, 5).join('\n') } };
  if (!(result.starts > 0)) return { status: 'fail', metrics, notes: { ...notes, error: 'no starts recorded' } };
  if (result.late !== 0) return { status: 'fail', metrics, notes: { ...notes, error: `${result.late} late start(s)` } };
  if (result.silentWindows !== 0) {
    return { status: 'fail', metrics, notes: { ...notes, error: `${result.silentWindows} silent RMS window(s) after the first second` } };
  }
  return { status: 'pass', metrics, notes };
}
