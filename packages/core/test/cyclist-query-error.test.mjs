import { describe, expect, it } from 'vitest';
import { Cyclist } from '../cyclist.mjs';
import { Pattern, sequence } from '../pattern.mjs';

function harness({ onTrigger } = {}) {
  let time = 10;
  let tick;
  const events = [];
  const errors = [];
  const scheduler = new Cyclist({
    getTime: () => time,
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = undefined;
    },
    onTrigger: (hap, ...args) => {
      onTrigger?.(hap, ...args);
      events.push(hap.value);
    },
    onError: (error) => errors.push(error),
  });
  return {
    scheduler,
    events,
    errors,
    advance: (seconds) => {
      time += seconds;
      tick?.();
    },
  };
}

const throwing = (message) =>
  sequence('bad').fast(16).fmap(() => {
    throw new Error(message);
  });

// queries normally until cycle `from`, then throws
const throwingFrom = (pat, from, message) =>
  new Pattern((state) => {
    if (state.span.end > from) {
      throw new Error(message);
    }
    return pat.query(state);
  });

describe('Cyclist query errors', () => {
  it('keeps playing the previous pattern when the new one throws at query time', async () => {
    const h = harness();
    const good = sequence('good').fast(16);
    await h.scheduler.setPattern(good);
    await h.scheduler.start();
    for (let i = 0; i < 5; i++) h.advance(0.1);
    const before = h.events.length;

    await h.scheduler.setPattern(throwing('q'));
    for (let i = 0; i < 20; i++) h.advance(0.1);

    expect(h.errors.map((e) => e.message)).toEqual(['q']);
    // 2 seconds at 0.5 cps is one cycle: 16 events
    expect(h.events.length).toBeGreaterThanOrEqual(before + 15);
    expect(h.events.every((value) => value === 'good')).toBe(true);
    expect(h.scheduler.pattern).toBe(good);
    h.scheduler.stop();
  });

  it('falls back when the new pattern only starts throwing after playing for a while', async () => {
    const h = harness();
    await h.scheduler.setPattern(sequence('good').fast(16));
    await h.scheduler.start();
    h.advance(0.1);
    await h.scheduler.setPattern(throwingFrom(sequence('later').fast(16), 2, 'late'));
    for (let i = 0; i < 60; i++) h.advance(0.1);

    expect(h.errors.map((e) => e.message)).toEqual(['late']);
    expect(h.events).toContain('later');
    expect(h.events.at(-1)).toBe('good');
    h.scheduler.stop();
  });

  it('plays the newest healthy pattern after a failed edit is fixed', async () => {
    const h = harness();
    await h.scheduler.setPattern(sequence('good').fast(16));
    await h.scheduler.start();
    h.advance(0.1);
    await h.scheduler.setPattern(throwing('q'));
    h.advance(0.1);
    await h.scheduler.setPattern(sequence('fixed').fast(16));
    const before = h.events.length;
    for (let i = 0; i < 5; i++) h.advance(0.1);

    expect(h.events.length).toBeGreaterThan(before);
    expect(h.events.slice(before).every((value) => value === 'fixed')).toBe(true);
    h.scheduler.stop();
  });

  it('reports errors without crashing when there is nothing to fall back to', async () => {
    const h = harness();
    await h.scheduler.setPattern(throwing('first'));
    await h.scheduler.start();
    for (let i = 0; i < 3; i++) h.advance(0.1);

    expect(h.events).toEqual([]);
    expect(h.errors.length).toBeGreaterThan(0);
    expect(h.errors.every((e) => e.message === 'first')).toBe(true);
    h.scheduler.stop();
  });

  it('does not revert the pattern when triggering a hap throws', async () => {
    let fail = false;
    const h = harness({
      onTrigger: () => {
        if (fail) throw new Error('trigger');
      },
    });
    await h.scheduler.setPattern(sequence('good').fast(16));
    await h.scheduler.start();
    h.advance(0.1);
    const next = sequence('next').fast(16);
    await h.scheduler.setPattern(next);
    fail = true;
    h.advance(0.1);

    expect(h.errors.map((e) => e.message)).toContain('trigger');
    expect(h.scheduler.pattern).toBe(next);
    h.scheduler.stop();
  });
});
