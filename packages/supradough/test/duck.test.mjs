import { describe, expect, it } from 'vitest';
import { note, stack } from '@strudel/core';
import { mini } from '@strudel/mini';
import { renderDoughStems } from '../render.mjs';

const SR = 48000;
const rmsAt = (samples, from, to) => {
  let sum = 0;
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / Math.round((to - from) * SR));
};
const db = (ratio) => 20 * Math.log10(ratio);

// orbits 1 and 3 hold a note; a silent trigger on orbit 2 at 0.25 s ducks orbit 1
const song = () =>
  stack(
    note(48).s('sine').orbit(1).attack(0).release(0.01),
    note(72).s('sine').orbit(2).gain(0).struct(mini('~ x ~ ~')).duckorbit(1).duckdepth(1).duckattack(0.1),
    note(60).s('sine').orbit(3).attack(0).release(0.01),
  );

describe('Dough ducking', () => {
  it('ducks the target orbit at the trigger and recovers over the attack time', () => {
    const { stems, mix } = renderDoughStems(song(), { cps: 1, cycles: 1, tail: 0 });
    const ducked = stems.get(1).left;
    const before = rmsAt(ducked, 0.2, 0.24);
    expect(db(before / rmsAt(ducked, 0.252, 0.26))).toBeGreaterThan(20);
    // back near full level once the 0.1 s attack has passed
    expect(db(before / rmsAt(ducked, 0.4, 0.45))).toBeLessThan(1);
    // the mix drops too
    expect(db(rmsAt(mix.left, 0.2, 0.24) / rmsAt(mix.left, 0.252, 0.26))).toBeGreaterThan(3);
  });

  it('leaves other orbits alone', () => {
    const { stems } = renderDoughStems(song(), { cps: 1, cycles: 1, tail: 0 });
    const other = stems.get(3).left;
    expect(Math.abs(db(rmsAt(other, 0.2, 0.24) / rmsAt(other, 0.252, 0.26)))).toBeLessThan(0.5);
  });
});
