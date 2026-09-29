// Pure checks shared by the CLI and browser probes. No Strudel imports.
import { cents } from './measure.mjs';

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
