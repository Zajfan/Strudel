import { describe, expect, it } from 'vitest';
import { Dough } from '../dough.mjs';

// a short render with noise and a supersaw, the users of randomness
function render(seed) {
  const dough = new Dough(48000, 0, seed);
  dough.scheduleSpawn({ s: 'white', _begin: 0, _duration: 0.05 });
  dough.scheduleSpawn({ s: 'pink', _begin: 0.02, _duration: 0.05 });
  dough.scheduleSpawn({ s: 'supersaw', note: 48, _begin: 0.04, _duration: 0.05 });
  const out = new Float32Array(4800);
  for (let i = 0; i < out.length; i++) {
    dough.update();
    out[i] = dough.out[0];
  }
  return out;
}

describe('Dough seed', () => {
  it('renders the same samples for the same seed', () => {
    const a = render(1);
    expect(a.some((x) => x !== 0)).toBe(true);
    expect(render(1)).toEqual(a);
  });

  it('renders differently for another seed', () => {
    expect(render(2)).not.toEqual(render(1));
  });
});
