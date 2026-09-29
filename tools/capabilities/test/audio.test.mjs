import { describe, expect, it } from 'vitest';
import { firstByteDifference, rms } from '../lib/audio.mjs';

describe('rms', () => {
  it('is 0 for silence and 1 for a full-scale square', () => {
    expect(rms(new Float32Array(8))).toBe(0);
    expect(rms(Float32Array.from([1, -1, 1, -1]))).toBe(1);
  });
  it('is 0 for an empty buffer', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe('firstByteDifference', () => {
  it('returns -1 for identical buffers', () => {
    expect(firstByteDifference(Float32Array.from([0.1, 0.2]), Float32Array.from([0.1, 0.2]))).toBe(-1);
  });
  it('returns the first differing index', () => {
    expect(firstByteDifference(Float32Array.from([0.1, 0.2, 0.3]), Float32Array.from([0.1, 0.25, 0.3]))).toBe(1);
  });
  it('distinguishes 0 from -0', () => {
    expect(firstByteDifference(Float32Array.from([0]), Float32Array.from([-0]))).toBe(0);
  });
  it('returns 0 when lengths differ', () => {
    expect(firstByteDifference(new Float32Array(2), new Float32Array(3))).toBe(0);
  });
});
