// LIVE-1 (browser): a failing evaluation mid-playback causes no audio gap > maxGapFrames; the
// previous pattern keeps playing. Instruments AudioScheduledSourceNode.prototype.start the same
// way as PERF-1, but only records OscillatorNode starts (the note's own oscillator) so that
// superdough's internal ConstantSourceNode scheduling/cleanup timers (also
// AudioScheduledSourceNode instances, see packages/superdough/helpers.mjs webAudioTimeout) don't
// pollute the event-grid measurement.
async function playThenBreak() {
  // Constant is inlined (not module-level) because ctx.page.evaluate stringifies only this
  // function; it has no closure over the rest of the module.
  const SETTLE_MS = 3000;
  const protoStart = AudioScheduledSourceNode.prototype.start;
  const starts = [];
  AudioScheduledSourceNode.prototype.start = function (when = 0, ...rest) {
    if (this instanceof OscillatorNode) {
      starts.push({ when, now: this.context.currentTime, freq: this.frequency.value, sampleRate: this.context.sampleRate });
    }
    return protoStart.call(this, when, ...rest);
  };
  try {
    const m = window.strudelMirror;
    m.setCode('note("c4").s("sine").fast(8).gain(0.05).release(0.01)');
    await m.evaluate();
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const splitIndex = starts.length;
    const cps = m.repl.scheduler.cps;
    // This evaluate is expected to fail (trailing `+` with no right-hand side); the REPL's
    // evaluate() catches the error internally and sets repl.state.error rather than throwing.
    m.setCode('note("c4").s("sine").fast(8).gain(0.05).release(0.01).lpf(800 +)');
    await m.evaluate();
    const errorMessage = String(m.repl.state.error || '');
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    m.stop();
    return { starts, splitIndex, cps, errorMessage };
  } finally {
    AudioScheduledSourceNode.prototype.start = protoStart;
  }
}

export async function probe({ page, thresholds }) {
  const notes = {
    scope: 'headless Chromium, fake audio device: measures scheduling lateness and rendered signal, not DAC underruns',
  };
  const maxGapFrames = thresholds.maxGapFrames;
  if (maxGapFrames == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold maxGapFrames missing' } };

  const result = await page.evaluate(playThenBreak, undefined, { timeoutMs: 30000 });
  const { starts, splitIndex, cps, errorMessage } = result;
  const errorReported = !!errorMessage;
  const startsBefore = splitIndex;
  const startsAfter = starts.length - splitIndex;
  const preFreq = splitIndex > 0 ? starts[splitIndex - 1].freq : null;
  const afterStarts = starts.slice(splitIndex);
  const sameFrequencyAfter = startsAfter > 0 && preFreq != null && afterStarts.every((s) => Math.abs(s.freq - preFreq) < 0.5);
  const sampleRate = starts.length ? starts[0].sampleRate : null;
  const grid = cps > 0 ? 1 / (cps * 8) : null;
  let maxDeviationS = 0;
  if (grid != null) {
    for (let i = 1; i < starts.length; i++) {
      const delta = starts[i].when - starts[i - 1].when;
      const deviation = Math.abs(delta - grid);
      if (deviation > maxDeviationS) maxDeviationS = deviation;
    }
  }
  const maxGapFramesMeasured = sampleRate != null && grid != null ? maxDeviationS * sampleRate : null;

  const metrics = {
    errorReported,
    startsBefore,
    startsAfter,
    maxGapFrames: maxGapFramesMeasured,
    sameFrequencyAfter,
    cps,
    grid,
    headline: `${startsAfter} after error, ${maxGapFramesMeasured == null ? 'n/a' : maxGapFramesMeasured.toFixed(1)} frame gap`,
  };

  if (starts.length === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no oscillator starts recorded' } };
  if (!errorReported) return { status: 'fail', metrics, notes: { ...notes, error: 'evaluate did not report an error' } };
  if (!(startsAfter > 0)) return { status: 'fail', metrics, notes: { ...notes, error: 'no starts after the failed evaluate' } };
  if (!sameFrequencyAfter) return { status: 'fail', metrics, notes: { ...notes, error: 'oscillator frequency changed after the failed evaluate' } };
  if (maxGapFramesMeasured == null || !(maxGapFramesMeasured <= maxGapFrames)) {
    return { status: 'fail', metrics, notes: { ...notes, error: `gap ${maxGapFramesMeasured} frames > ${maxGapFrames}` } };
  }
  return { status: 'pass', metrics, notes };
}
