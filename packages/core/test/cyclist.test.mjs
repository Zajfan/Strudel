import { describe, expect, it } from 'vitest';
import { Cyclist } from '../cyclist.mjs';
import { sequence } from '../pattern.mjs';

function harness() {
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
    onTrigger: (hap, deadline, duration, cps, targetTime) => {
      events.push({ value: hap.value, duration, targetTime, scheduledAt: time });
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

describe('Cyclist scheduling contract', () => {
  it('schedules dense events once, ahead of time, without accumulating timing drift', async () => {
    const h = harness();
    const values = Array.from({ length: 64 }, (_, i) => i);
    await h.scheduler.setPattern(sequence(...values));
    await h.scheduler.start();
    for (let i = 0; i < 600; i++) h.advance(0.1);
    expect(h.errors).toEqual([]);
    expect(h.events.length).toBeGreaterThan(1900);
    h.events.forEach((event, i) => {
      expect(event.value).toBe(i % 64);
      expect(event.targetTime).toBeCloseTo(10.11 + i / 32, 8);
      expect(event.duration).toBeCloseTo(1 / 32, 8);
      expect(event.targetTime).toBeGreaterThan(event.scheduledAt);
    });
    h.scheduler.stop();
  });

  it('replaces future events and stops dispatching after stop', async () => {
    const h = harness();
    await h.scheduler.setPattern(sequence('old').fast(16));
    await h.scheduler.start();
    const previousCount = h.events.length;
    await h.scheduler.setPattern(sequence('new').fast(16));
    h.advance(0.1);
    expect(h.events.length).toBeGreaterThan(previousCount);
    expect(h.events.slice(previousCount).every((event) => event.value === 'new')).toBe(true);
    h.scheduler.stop();
    const stoppedCount = h.events.length;
    h.advance(1);
    expect(h.events).toHaveLength(stoppedCount);
    expect(h.errors).toEqual([]);
  });
});
