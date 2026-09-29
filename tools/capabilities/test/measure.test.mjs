import { describe, expect, it } from 'vitest';
import { cents, decodeFloat32, estimateFrequency, firstIndexAbove, toDb, windowRms } from '../lib/measure.mjs';

const sine = (freq, seconds, sampleRate = 48000, amp = 0.5) =>
  Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));

describe('firstIndexAbove', () => {
  it('finds the first sample whose magnitude exceeds the threshold', () => {
    expect(firstIndexAbove(Float32Array.from([0, 0, -0.2, 0.5]), 0.1)).toBe(2);
  });
  it('respects the search window and returns -1 when nothing is found', () => {
    const x = Float32Array.from([0.5, 0, 0, 0.5]);
    expect(firstIndexAbove(x, 0.1, 1, 3)).toBe(-1);
    expect(firstIndexAbove(x, 0.1, 1)).toBe(3);
  });
});

describe('windowRms', () => {
  it('measures a window and clamps its bounds', () => {
    const x = Float32Array.from([1, -1, 1, -1, 0, 0]);
    expect(windowRms(x, 0, 4)).toBe(1);
    expect(windowRms(x, 4, 100)).toBe(0);
    expect(windowRms(x, 3, 3)).toBe(0);
  });
});

describe('toDb and cents', () => {
  it('converts ratios', () => {
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(toDb(0)).toBe(-Infinity);
    expect(cents(440 * Math.pow(2, 1 / 12), 440)).toBeCloseTo(100, 6);
  });
});

describe('estimateFrequency', () => {
  it('measures a 19-EDO step within 0.1 cent', () => {
    const f = 220 * Math.pow(2, 7 / 19);
    const est = estimateFrequency(sine(f, 0.5), 48000, 0, 24000);
    expect(Math.abs(cents(est, f))).toBeLessThan(0.1);
  });
  it('returns NaN for silence', () => {
    expect(estimateFrequency(new Float32Array(4800), 48000, 0, 4800)).toBeNaN();
  });
});

describe('decodeFloat32', () => {
  it('round-trips Float32 bytes through base64', () => {
    const x = Float32Array.from([0.25, -1, 3.5]);
    const b64 = Buffer.from(x.buffer).toString('base64');
    expect(Array.from(decodeFloat32(b64))).toEqual([0.25, -1, 3.5]);
  });
});
