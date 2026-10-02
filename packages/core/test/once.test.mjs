import { describe, expect, it } from 'vitest';
import { Cyclist } from '../cyclist.mjs';
import { arrange, sequence, sine, stack } from '../index.mjs';

const onsets = (pat, begin, end) =>
  pat
    .queryArc(begin, end)
    .filter((hap) => hap.hasOnset())
    .map((hap) => [hap.whole.begin.valueOf(), hap.value]);

const song = () => arrange([2, sequence('a', 'b')], [1, sequence('c')]);

describe('once', () => {
  it('plays an arrangement through once, then nothing', () => {
    expect(song()._period.valueOf()).toBe(3);
    const pat = song().once();
    expect(onsets(pat, 0, 3)).toEqual([
      [0, 'a'],
      [0.5, 'b'],
      [1, 'a'],
      [1.5, 'b'],
      [2, 'c'],
    ]);
    expect(onsets(pat, 3, 100)).toEqual([]);
    expect(onsets(pat, -3, 0)).toEqual([]);
    expect(pat._end.valueOf()).toBe(3);
  });

  it('keeps the length through value-only methods', () => {
    const pat = song()
      .fmap((v) => ({ s: v }))
      .room(0.3)
      .gain(sine.range(0.5, 1))
      .once();
    expect(pat._end.valueOf()).toBe(3);
    expect(onsets(pat, 0, 10)).toHaveLength(5);
  });

  it('plays one cycle of a pattern with no known length', () => {
    const pat = sequence('a', 'b').once();
    expect(onsets(pat, 0, 10)).toEqual([
      [0, 'a'],
      [0.5, 'b'],
    ]);
  });

  it('drops the length after time changes, rather than keeping a wrong one', () => {
    expect(song().fast(2)._period).toBeUndefined();
    expect(song().once().fast(2)._end).toBeUndefined();
  });

  it('ends a stack when every layer ends', () => {
    expect(stack(song().once(), sequence('x').once())._end.valueOf()).toBe(3);
    expect(stack(song().once(), sequence('x'))._end).toBeUndefined();
  });

  it('keeps the end through per-pattern state (as the REPL adds for $: labels)', () => {
    const pat = song()
      .once()
      .withState((state) => state.setControls({ id: 'a' }));
    expect(pat._end.valueOf()).toBe(3);
  });
});

describe('Cyclist with a pattern that ends', () => {
  it('stops the transport after scheduling the last event', async () => {
    let time = 10;
    let tick;
    const events = [];
    const toggles = [];
    const scheduler = new Cyclist({
      getTime: () => time,
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        tick = undefined;
      },
      onTrigger: (hap) => events.push(hap.value),
      onToggle: (started) => toggles.push(started),
    });
    await scheduler.setPattern(song().once());
    await scheduler.start();
    // 3 cycles at 0.5 cps = 6 seconds
    for (let i = 0; i < 100 && scheduler.started; i++) {
      time += 0.1;
      tick?.();
      await Promise.resolve();
    }
    expect(events).toEqual(['a', 'b', 'a', 'b', 'c']);
    expect(scheduler.started).toBe(false);
    expect(toggles).toEqual([true, false]);
    expect(time).toBeGreaterThan(15);
    expect(time).toBeLessThan(17);
  });
});
