import { describe, expect, it } from 'vitest';
import { note, stack } from '@strudel/core';
import { encodeWav, renderDough, renderDoughStems } from '../render.mjs';

const opts = { cps: 1, cycles: 1, tail: 0.5 };
// orbit 1: a short dry note; orbit 2: a short note into a long delay
const song = () =>
  stack(
    note(48).s('sine').orbit(1).release(0.01).clip(0.1),
    note(60).s('triangle').orbit(2).release(0.01).clip(0.1).delay(0.8).delaytime(0.3).delayfeedback(0.6),
  );
const peak = (samples, from, to) => samples.slice(from, to).reduce((max, x) => Math.max(max, Math.abs(x)), 0);

describe('renderDoughStems', () => {
  it('renders one stem per orbit that add up to the mix', () => {
    const { mix, stems } = renderDoughStems(song(), opts);
    expect([...stems.keys()]).toEqual([1, 2]);
    const { left } = renderDough(song(), opts);
    expect(mix.left).toEqual(left);
    let worst = 0;
    for (let i = 0; i < left.length; i++) {
      worst = Math.max(worst, Math.abs(left[i] - stems.get(1).left[i] - stems.get(2).left[i]));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("keeps an orbit's delay in that orbit's stem", () => {
    const { stems } = renderDoughStems(song(), opts);
    // after both notes have ended (0.1 cycle at 1 cps), only orbit 2's delay is still sounding
    const [from, to] = [48000 * 0.35, 48000 * 1.2];
    expect(peak(stems.get(1).left, from, to)).toBe(0);
    expect(peak(stems.get(2).left, from, to)).toBeGreaterThan(0.001);
  });

  it('renders the same samples twice', () => {
    expect(renderDough(song(), opts).left).toEqual(renderDough(song(), opts).left);
  });
});

describe('encodeWav', () => {
  it('writes a stereo 16-bit WAV with the right header and samples', () => {
    const left = new Float32Array([0, 0.5, -1, 1]);
    const right = new Float32Array([0, -0.5, 1, 2]); // 2 is clipped to 1
    const wav = encodeWav([left, right], 48000);
    const view = new DataView(wav.buffer);
    const text = (offset) => String.fromCharCode(...wav.slice(offset, offset + 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(4 * 2 * 2); // frames * channels * bytes
    const samples = Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true));
    // negative samples scale by 0x8000, positive by 0x7fff
    expect(samples).toEqual([0, 0, 16383, -16384, -32768, 32767, 32767, 32767]);
  });
});
