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
  for (const [, line, column] of String(err?.stack ?? '').matchAll(/<anonymous>:(\d+):(\d+)/g)) {
    if (Number(line) <= userLineCount) return { line: Number(line), column: Number(column), source: 'stack' };
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
