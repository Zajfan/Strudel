// Pure checks shared by the CLI and browser probes. No Strudel imports.
import { cents, firstIndexAbove, toDb, windowRms } from './measure.mjs';

export function checkArrangement(haps, { sections, bars }) {
  const end = sections * bars;
  let eventsInSong = 0;
  let wrongSection = 0;
  let eventsAfterEnd = 0;
  for (const hap of haps) {
    const begin = Number(hap.whole.begin);
    if (begin >= end) {
      eventsAfterEnd++;
      continue;
    }
    eventsInSong++;
    if (hap.value.note !== 60 + Math.floor(begin / bars)) wrongSection++;
  }
  return { eventsInSong, wrongSection, eventsAfterEnd };
}

// ARR-1 verdict shared by the CLI and browser probes. candidates: [{ name, ...checkArrangement() }].
// Passes if any candidate construct has events, all in the right section, and none after the end.
export function judgeArrangement(candidates, { sections, bars }) {
  const end = sections * bars;
  const ok = (c) => c.eventsInSong > 0 && c.wrongSection === 0 && c.eventsAfterEnd === 0;
  const bare = candidates.find((c) => c.name === 'arrange()');
  // the dedicated construct for a hard ending; the others are workarounds
  const dedicated = candidates.find((c) => c.name === 'arrange().once()');
  const notes = {};
  if (bare?.eventsAfterEnd > 0 && !(dedicated && ok(dedicated))) {
    notes.ergonomics = `bare arrange() loops: ${bare.eventsAfterEnd} events after bar ${end}; a hard ending needs an extra construct (filterWhen or a silence tail)`;
  }
  const metrics = { sections, bars: end, candidates };
  const passing = dedicated && ok(dedicated) ? dedicated : candidates.find(ok);
  if (passing) {
    return {
      status: 'pass',
      metrics: { ...metrics, headline: `${sections} sections, ${end} bars via ${passing.name}` },
      notes: { ...notes, construct: passing.name },
    };
  }
  const summary = candidates
    .map((c) => `${c.name}: ${c.eventsInSong} in song, ${c.wrongSection} wrong section, ${c.eventsAfterEnd} after bar ${end}`)
    .join('; ');
  return {
    status: 'fail',
    metrics: { ...metrics, headline: `no construct ends at bar ${end}` },
    notes: { ...notes, error: summary || 'no candidate constructs' },
  };
}

export function checkTuning(values, expected) {
  if (values.length !== expected.length) return { count: values.length, maxCents: Infinity };
  let maxCents = 0;
  values.forEach((v, k) => {
    const deviation = typeof v.freq === 'number' ? Math.abs(cents(v.freq, expected[k])) : Infinity;
    maxCents = Math.max(maxCents, deviation);
  });
  return { count: values.length, maxCents };
}

export function locateError(err, userLineCount) {
  if (err?.loc) return { line: err.loc.line, column: err.loc.column, source: 'loc' };
  const fromMessage = /\((\d+):(\d+)\)\s*$/.exec(err?.message ?? '');
  if (fromMessage) return { line: Number(fromMessage[1]), column: Number(fromMessage[2]), source: 'message' };
  // V8 stack columns are 1-based; acorn's loc and the '(line:column)' message suffix are 0-based.
  // Convert so every source reports the same 0-based column that ERROR_CASES expects.
  for (const [, line, column] of String(err?.stack ?? '').matchAll(/<anonymous>:(\d+):(\d+)/g)) {
    if (Number(line) <= userLineCount) return { line: Number(line), column: Number(column) - 1, source: 'stack' };
  }
  return null;
}

export function analyzeSteps(samples, sampleRate, { steps, cps }) {
  const stepLen = sampleRate / (steps * cps);
  const slack = Math.round(0.005 * sampleRate);
  const onsets = [];
  const rms = [];
  let maxErrorMs = 0;
  for (let k = 0; k < steps; k++) {
    const expected = Math.round(k * stepLen);
    const found = firstIndexAbove(samples, 1e-4, expected - slack, expected + slack);
    const errorMs = found < 0 ? Infinity : (Math.abs(found - expected) / sampleRate) * 1000;
    maxErrorMs = Math.max(maxErrorMs, errorMs);
    onsets.push({ expected, found, errorMs });
    rms.push(windowRms(samples, expected + stepLen / 8, expected + (3 * stepLen) / 8));
  }
  const increasing = rms.every((v, k) => k === 0 || v > rms[k - 1]);
  return { onsets, maxErrorMs, rms, increasing };
}

export function duckDrop(samples, sampleRate, { triggerAt }) {
  const at = (s) => Math.round(s * sampleRate);
  const beforeRms = windowRms(samples, at(triggerAt - 0.05), at(triggerAt - 0.01));
  const afterRms = windowRms(samples, at(triggerAt + 0.005), at(triggerAt + 0.025));
  return { beforeRms, afterRms, dropDb: -toDb(afterRms / beforeRms) };
}

// duckDrop around an explicit trigger sample index (e.g. a trigger located in a live recording).
export function duckDropAt(samples, sampleRate, triggerIndex) {
  return duckDrop(samples, sampleRate, { triggerAt: triggerIndex / sampleRate });
}

// Detection floor for "did the level change at all within the note" (used with rampWithinNote), not
// a spec threshold: a continuous ramp from 0.1 to 1 clears this by a wide margin, while a value
// sampled once per event (and held for the rest of the note) stays near 0 dB.
export const RAMP_DETECTION_DB = 3;

// RMS in two windows within the first cycle (a continuous ramp should differ; a value sampled
// once per event should not). Windows are fractions of the cycle length so they scale with cps.
export function rampWithinNote(samples, sampleRate, { cps }) {
  const cycleLen = sampleRate / cps;
  const firstRms = windowRms(samples, 0.05 * cycleLen, 0.25 * cycleLen);
  const lastRms = windowRms(samples, 0.75 * cycleLen, 0.95 * cycleLen);
  return { firstRms, lastRms, changeDb: toDb(lastRms / firstRms) };
}

export function stemResidual(mix, stems) {
  let worst = 0;
  for (let i = 0; i < mix.length; i++) {
    let sum = 0;
    for (const stem of stems) sum += stem[i] ?? 0;
    worst = Math.max(worst, Math.abs(mix[i] - sum));
  }
  return { residualDbfs: toDb(worst) };
}

// EXP-2: does an exported name look like a stem API? Matches 'stem'/'stems' as a word of the
// camelCase- or snake_case-split name ('renderStems', 'STEM_EXPORT'), not as a substring of
// another word ('system', 'ecosystem', 'stemmer').
export function isStemApiName(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return /(^|[^a-z])stems?([^a-z]|$)/i.test(words);
}

// EXP-2 verdict shared by the CLI and browser probes. An API that is found but not driven by the
// probe can never pass: its name is not evidence that it exports stems.
export function judgeStems({ apis, exercised, residualDbfs, eventCount }, thresholds) {
  if (!(eventCount > 0)) return { status: 'fail', error: 'no events rendered' };
  if (thresholds?.maxResidualDbfs == null) return { status: 'fail', error: 'threshold maxResidualDbfs missing' };
  if (!apis?.length) return { status: 'fail', error: 'no stem export API' };
  if (!exercised) return { status: 'not-run', reason: `stem-like API found but not exercised: ${apis.join(', ')}` };
  if (!(residualDbfs <= thresholds.maxResidualDbfs)) {
    return { status: 'fail', error: `stem residual ${residualDbfs} dBFS > ${thresholds.maxResidualDbfs} dBFS` };
  }
  return { status: 'pass' };
}

// PERF-1 (browser): the fewest note starts V voices must produce in durationS at cps, allowing one
// partial cycle at each end of the measurement window. NaN (fails any >= check) on missing input.
export function expectedMinStarts({ voices, durationS, cps }) {
  const cycles = Math.floor(durationS * cps) - 1;
  return voices * Math.max(0, cycles);
}

// superdough drops a hap whose time is already past with this console.warn and never starts it
// (packages/superdough/superdough.mjs, "cannot schedule sounds in the past").
export const PAST_SCHEDULE_RE = /cannot schedule sounds in the past/i;

export function countPastScheduleWarnings(warnings) {
  return warnings.filter((w) => PAST_SCHEDULE_RE.test(String(w))).length;
}

// Longest run of consecutive samples with |x| < threshold in [from, to).
export function longestSilentRun(samples, threshold, from = 0, to = samples.length) {
  let longest = 0;
  let run = 0;
  for (let i = Math.max(0, from); i < Math.min(to, samples.length); i++) {
    if (Math.abs(samples[i]) < threshold) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

// LIVE-1: the audio-level gap a failed evaluation causes, in excess of the pattern's own silence.
// ownGapFrames is the longest near-silent run between the first note and the failure; the
// longest run from the first note to the end of the recording, minus that, is the excess.
// Without a note before the failure there is no baseline, so the excess is Infinity. `from` skips
// audio before the pattern's first scheduled note (e.g. the tail of a previous recording).
export function liveGap(samples, { failureIndex, threshold = 1e-4, from = 0 }) {
  const firstNote = firstIndexAbove(samples, threshold, from, failureIndex);
  if (firstNote < 0) return { firstNote, ownGapFrames: null, longestGapFrames: null, excessFrames: Infinity };
  const ownGapFrames = longestSilentRun(samples, threshold, firstNote, failureIndex);
  const longestGapFrames = longestSilentRun(samples, threshold, firstNote);
  return { firstNote, ownGapFrames, longestGapFrames, excessFrames: Math.max(0, longestGapFrames - ownGapFrames) };
}
