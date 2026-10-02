// LIVE-1 (browser): a failing evaluation mid-playback causes no audio gap > maxGapFrames and the
// previous pattern keeps playing. Three failure kinds are tried in turn against the same steady
// pattern (playback is stopped between cases): a syntax error, a throw while the code is evaluated,
// and a throw while the scheduler queries the new pattern. Each case is recorded from the master
// mix with recordLive (an AudioWorklet tap, lib/browser/page-recorder.mjs). The gap is measured on
// the audio: the longest near-silent run after the first note, in excess of the pattern's own
// silence between notes (liveGap). Only OscillatorNode starts are logged, so superdough's
// ConstantSourceNode cleanup timers (packages/superdough/helpers.mjs webAudioTimeout) don't count.
import { recordLive } from '../../lib/browser/page-recorder.mjs';
import { liveGap } from '../../lib/checks.mjs';

const SETTLE_SECONDS = 3;
const STEADY = 'note("c4").s("sine").fast(8).gain(0.05).release(0.01)';
// The failing programs use e4, so if one of them replaced the steady pattern the pitch would change.
// Error messages are single-quoted: the transpiler turns double-quoted strings into mini-notation patterns.
const CASES = [
  { name: 'syntax error', code: 'note("e4").s("sine").fast(8).gain(0.05).release(0.01).lpf(800 +)' },
  { name: 'eval-time throw', code: 'note("e4").s("sine").fast(8).gain(0.05).release(0.01); throw new Error(\'boom\')' },
  {
    name: 'query-time throw',
    code: 'note("e4").s("sine").fast(8).gain(0.05).release(0.01).fmap(() => { throw new Error(\'q\') })',
  },
];

async function runCase(page, c) {
  const live = await recordLive(page, [
    { code: STEADY, seconds: SETTLE_SECONDS },
    { code: c.code, seconds: SETTLE_SECONDS },
  ]);
  const { left, sampleRate, startFrame, starts, steps, log } = live;
  const failAt = steps[1].at;
  const failureIndex = Math.round(failAt * sampleRate) - startFrame;
  const before = starts.filter((s) => s.now < failAt);
  const after = starts.filter((s) => s.now >= failAt);
  const preFreq = before.length ? before.at(-1).freq : null;
  const sameFrequencyAfter = after.length > 0 && preFreq != null && after.every((s) => Math.abs(s.freq - preFreq) < 0.5);
  const logErrors = log.filter((l) => l.time >= failAt && (l.type === 'error' || /error/i.test(l.message))).map((l) => l.message);
  const errorMessage = steps[1].errorAfterEval || steps[1].errorAfterWait || logErrors[0] || '';
  // Start the baseline at the steady pattern's first scheduled note: the recording can open on the
  // tail of the previous case's notes, and the hole between the two is not the pattern's own gap.
  const firstStartIndex = before.length ? Math.max(0, Math.round(before[0].when * sampleRate) - startFrame) : failureIndex;
  const gap = liveGap(left, { failureIndex, from: firstStartIndex });
  return {
    name: c.name,
    steadyError: steps[0].errorAfterWait,
    errorReported: !!errorMessage,
    errorMessage,
    startsBefore: before.length,
    startsAfter: after.length,
    sameFrequencyAfter,
    recordedSamples: left.length,
    failureIndex,
    firstNote: gap.firstNote,
    ownGapFrames: gap.ownGapFrames,
    longestGapFrames: gap.longestGapFrames,
    gapExcessFrames: gap.excessFrames,
  };
}

function caseProblem(r, maxGapFrames) {
  if (r.steadyError) return `steady pattern failed: ${r.steadyError}`;
  if (r.startsBefore === 0) return 'no oscillator starts before the failure';
  if (!r.errorReported) return 'the failure was not reported';
  if (!(r.startsAfter > 0)) return 'no starts after the failure';
  if (!r.sameFrequencyAfter) return 'pitch changed after the failure (the failing code replaced the pattern)';
  if (!(r.gapExcessFrames <= maxGapFrames)) return `audio gap ${r.gapExcessFrames} frames beyond the pattern's own ${r.ownGapFrames}`;
  return null;
}

export async function probe({ page, thresholds }) {
  const notes = {
    scope: 'headless Chromium, fake audio device: measures the rendered master mix and Web Audio scheduling, not DAC underruns',
    gap: 'longest run of |x| < 1e-4 after the first note, minus the longest such run before the failure (the pattern own silence)',
  };
  const maxGapFrames = thresholds.maxGapFrames;
  if (maxGapFrames == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold maxGapFrames missing' } };

  const cases = [];
  for (const c of CASES) cases.push(await runCase(page, c));
  const problems = cases.map((r) => ({ name: r.name, problem: caseProblem(r, maxGapFrames) })).filter((p) => p.problem);
  const worstExcess = Math.max(...cases.map((r) => r.gapExcessFrames));
  const metrics = {
    cases,
    maxGapExcessFrames: worstExcess,
    headline: problems.length
      ? `${cases.length - problems.length}/${cases.length} cases safe; ${problems.map((p) => p.name).join(', ')} not`
      : `${cases.length}/${cases.length} cases safe, ${worstExcess} frame gap`,
  };
  if (problems.length) {
    return { status: 'fail', metrics, notes: { ...notes, error: problems.map((p) => `${p.name}: ${p.problem}`).join('; ') } };
  }
  return { status: 'pass', metrics, notes };
}
