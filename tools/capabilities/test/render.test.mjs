import { describe, expect, it } from 'vitest';
import { note, sequence, silence } from '@strudel/core';
import { renderPattern } from '../lib/render.mjs';
import { rms } from '../lib/audio.mjs';

describe('renderPattern', () => {
  it('renders two sine notes to a non-silent buffer of the expected length', () => {
    const out = renderPattern(note(sequence(60, 64)).s('sine'), { cps: 1, cycles: 1, tail: 0.5 });
    expect(out.eventCount).toBe(2);
    expect(out.left.length).toBe(72000);
    expect(out.right.length).toBe(72000);
    expect(out.audioSeconds).toBe(1.5);
    expect(rms(out.left)).toBeGreaterThan(0.001);
  });
  it('renders silence and zero events for a silent pattern', () => {
    const out = renderPattern(silence, { cps: 1, cycles: 1, tail: 0 });
    expect(out.eventCount).toBe(0);
    expect(rms(out.left)).toBe(0);
  });
});
