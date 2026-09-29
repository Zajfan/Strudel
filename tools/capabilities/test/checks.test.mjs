import { describe, expect, it } from 'vitest';
import { checkArrangement, checkTuning, locateError } from '../lib/checks.mjs';

const hap = (begin, note) => ({ whole: { begin }, value: { note } });

describe('checkArrangement', () => {
  it('counts wrong sections and events after the end', () => {
    const haps = [hap(0, 60), hap(8, 61), hap(9, 60), hap(64, 60)];
    expect(checkArrangement(haps, { sections: 8, bars: 8 })).toEqual({ eventsInSong: 3, wrongSection: 1, eventsAfterEnd: 1 });
  });
});

describe('checkTuning', () => {
  it('reports the largest deviation in cents', () => {
    const r = checkTuning([{ freq: 220 }, { freq: 440 * Math.pow(2, 2 / 1200) }], [220, 440]);
    expect(r.count).toBe(2);
    expect(r.maxCents).toBeCloseTo(2, 6);
  });
  it('treats a missing frequency as an infinite deviation', () => {
    expect(checkTuning([{}], [220]).maxCents).toBe(Infinity);
  });
  it('treats a count mismatch as an infinite deviation', () => {
    expect(checkTuning([{ freq: 220 }], [220, 440]).maxCents).toBe(Infinity);
  });
});

describe('locateError', () => {
  it('prefers err.loc', () => {
    expect(locateError({ loc: { line: 3, column: 12 }, message: 'x' }, 3)).toEqual({ line: 3, column: 12, source: 'loc' });
  });
  it('falls back to a (line:column) message suffix', () => {
    expect(locateError({ message: 'Unexpected token (2:5)' }, 3)).toEqual({ line: 2, column: 5, source: 'message' });
  });
  it('falls back to the first anonymous stack frame inside the user code', () => {
    const stack = 'TypeError: x\n    at eval (eval at f (file.mjs:1:1), <anonymous>:3:78)';
    expect(locateError({ message: 'x', stack }, 3)).toEqual({ line: 3, column: 78, source: 'stack' });
  });
  it('returns null when nothing locates the error', () => {
    expect(locateError({ message: 'x', stack: 'at <anonymous>:9:1' }, 3)).toBeNull();
  });
});
