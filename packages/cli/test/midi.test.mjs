import { describe, expect, it, vi } from 'vitest';
import { midiMessages, sendAt } from '../midi-messages.mjs';

describe('midiMessages', () => {
  it('turns a note into note-on and a note-off just before the note ends', () => {
    expect(midiMessages({ note: 'c4', velocity: 1, midichan: 2 }, { time: 1000, duration: 500 })).toEqual([
      { time: 1000, bytes: [0x91, 60, 127] },
      { time: 1490, bytes: [0x81, 60, 0] },
    ]);
  });

  it('scales velocity by gain, with the default velocity of 0.9', () => {
    expect(midiMessages({ note: 60, gain: 0.5 }, { time: 0, duration: 100 })[0].bytes).toEqual([0x90, 60, 57]);
  });

  it('sends control changes, program changes and midicmd', () => {
    expect(midiMessages({ ccn: 74, ccv: 0.5 }, { time: 5, duration: 10 })).toEqual([{ time: 5, bytes: [0xb0, 74, 64] }]);
    expect(midiMessages({ progNum: 3 }, { time: 5, duration: 10 })).toEqual([{ time: 5, bytes: [0xc0, 3] }]);
    expect(midiMessages({ midicmd: 'clock' }, { time: 7, duration: 10 })).toEqual([{ time: 7, bytes: [0xf8] }]);
    expect(midiMessages({ midicmd: 'start' }, { time: 7, duration: 10 })[0].bytes).toEqual([0xfa]);
  });

  it('rejects a control value outside 0..1', () => {
    expect(() => midiMessages({ ccn: 1, ccv: 2 }, { time: 0, duration: 1 })).toThrow(/between 0 and 1/);
  });
});

describe('sendAt', () => {
  it('sends right away when the time has come', () => {
    const send = vi.fn();
    sendAt(100, send, () => 100);
    expect(send).toHaveBeenCalledOnce();
  });

  // On a controlled clock: a timer until shortly before the time, then the spin until the time.
  // (How close to the time it sends on a real clock is measured by the CLI's SYNC-1 probe; here, on
  // a machine loaded by parallel test files, a timer can wake up any number of ms late.)
  it('waits with a timer, then sends once the clock reaches the time, not before', () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const readings = [];
      // each reading advances the clock a little, as spinning on a real one does
      const now = () => {
        readings.push(clock);
        return (clock += 0.25);
      };
      const send = vi.fn(() => readings.push('sent'));
      sendAt(30, send, now);
      expect(send).not.toHaveBeenCalled();
      // the timer runs out before the time, the spin takes it from there
      clock = 28.5;
      vi.runAllTimers();
      expect(send).toHaveBeenCalledOnce();
      const sentAfter = readings[readings.indexOf('sent') - 1];
      expect(sentAfter).toBeGreaterThanOrEqual(29.75);
      expect(sentAfter).toBeLessThan(30.25);
    } finally {
      vi.useRealTimers();
    }
  });
});
