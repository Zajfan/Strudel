import { describe, expect, it } from 'vitest';
import { analyzeSteps, checkArrangement, checkTuning, duckDrop, locateError, rampWithinNote, stemResidual } from '../lib/checks.mjs';

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

describe('analyzeSteps', () => {
  it('finds onsets on the grid and a rising level', () => {
    const sr = 1600;
    const x = new Float32Array(sr);
    for (let k = 0; k < 16; k++) for (let i = 0; i < 50; i++) x[k * 100 + i] = 0.1 * (k + 1) * (i % 2 ? 1 : -1);
    const r = analyzeSteps(x, sr, { steps: 16, cps: 1 });
    expect(r.maxErrorMs).toBe(0);
    expect(r.increasing).toBe(true);
  });
  it('reports Infinity when an onset is missing', () => {
    expect(analyzeSteps(new Float32Array(1600), 1600, { steps: 16, cps: 1 }).maxErrorMs).toBe(Infinity);
  });
});

describe('duckDrop', () => {
  it('measures the level drop after the trigger in dB', () => {
    const sr = 1000;
    const x = new Float32Array(sr).map((_, i) => (i < 250 ? 1 : 0.5) * (i % 2 ? 1 : -1));
    expect(duckDrop(x, sr, { cps: 1, triggerAt: 0.25 }).dropDb).toBeCloseTo(6.0206, 3);
  });
});

describe('rampWithinNote', () => {
  it('is near 0 dB for a constant-amplitude tone', () => {
    const sr = 1000;
    const x = Float32Array.from({ length: sr }, (_, i) => 0.5 * (i % 2 ? 1 : -1));
    expect(rampWithinNote(x, sr, { cps: 1 }).changeDb).toBeCloseTo(0, 6);
  });
  it('reports ~+6.02 dB when the amplitude doubles between the windows', () => {
    const sr = 1000;
    const x = Float32Array.from({ length: sr }, (_, i) => (i < 500 ? 0.25 : 0.5) * (i % 2 ? 1 : -1));
    expect(rampWithinNote(x, sr, { cps: 1 }).changeDb).toBeCloseTo(6.0206, 3);
  });
});

describe('stemResidual', () => {
  it('is -Infinity when stems sum exactly to the mix', () => {
    const a = Float32Array.from([0.5, -0.25]);
    const b = Float32Array.from([0.25, 0.25]);
    expect(stemResidual(Float32Array.from([0.75, 0]), [a, b]).residualDbfs).toBe(-Infinity);
  });
  it('reports the worst sample difference in dBFS', () => {
    expect(stemResidual(Float32Array.from([0.1]), [Float32Array.from([0])]).residualDbfs).toBeCloseTo(-20, 6);
  });
});
