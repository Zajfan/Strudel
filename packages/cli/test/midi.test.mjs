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

  it('sends once the clock reaches the time, not before', async () => {
    const start = performance.now();
    const sentAt = await new Promise((resolve) => sendAt(start + 30, () => resolve(performance.now())));
    expect(sentAt).toBeGreaterThanOrEqual(start + 30);
    expect(sentAt - (start + 30)).toBeLessThan(5);
  });
});
