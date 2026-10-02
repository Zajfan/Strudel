import { describe, expect, it } from 'vitest';
import { note, saw, sequence } from '../index.mjs';

const first = (pat) => pat.queryArc(0, 1).filter((h) => h.hasOnset())[0].value;

describe('auto', () => {
  it('samples the signal over the note into a curve for the preceding control', () => {
    const v = first(note(48).s('sine').lpf(500).auto(saw.range(200, 1000), { res: 4 }));
    expect(v.auto.__ids).toEqual(new Set([0]));
    expect(v.auto[0].control).toBe('cutoff');
    // a 1-cycle note at 4 points per cycle: 5 points from begin to (just before) the end
    expect(v.auto[0].curve.map((x) => Math.round(x))).toEqual([200, 400, 600, 800, 1000]);
    // the control itself starts at the signal's value
    expect(v.cutoff).toBe(200);
  });

  it('follows song time, so a later note continues the curve', () => {
    const pat = note(sequence(48, 50)).s('sine').gain(1).auto(saw.slow(2), { res: 4 });
    const round = (curve) => curve.map((x) => Math.round(x * 1000) / 1000);
    const [a, b] = pat.queryArc(0, 1).filter((h) => h.hasOnset()).map((h) => round(h.value.auto[0].curve));
    expect(a).toEqual([0, 0.125, 0.25]);
    expect(b).toEqual([0.25, 0.375, 0.5]);
  });

  it('automates a named control, and several automations stack', () => {
    const v = first(note(48).s('sine').lpf(500).auto(saw, { res: 1 }).auto(saw.range(0.5, 1), { c: 'gain', res: 1 }));
    expect([...v.auto.__ids]).toEqual([0, 1]);
    expect(v.auto[1].control).toBe('gain');
    expect(v.gain).toBe(0.5);
    expect(v.cutoff).toBe(0);
  });

  it('takes the control and resolution as patterns, as the REPL passes mini-notation strings', () => {
    const v = first(note(48).s('sine').auto(saw, { c: sequence('lpf'), res: sequence(2) }));
    expect(v.auto[0].control).toBe('cutoff');
    expect(v.auto[0].curve).toHaveLength(3);
    expect(() => JSON.stringify(v)).not.toThrow();
  });

  it('resolves control aliases', () => {
    expect(first(note(48).auto(saw, { c: 'lpf', res: 1 })).auto[0].control).toBe('cutoff');
  });
});
