import { describe, expect, it } from 'vitest';
import { ClockBridge } from '../clockbridge.mjs';

// a fake AudioContext whose output timestamps carry the given offset (ms) at each performance time
function bridgeWith(offsetAt) {
  let now = 1000;
  const audioContext = {
    getOutputTimestamp: () => ({ performanceTime: now, contextTime: (now - offsetAt(now)) / 1000 }),
  };
  return { bridge: new ClockBridge(audioContext), advance: (ms) => (now += ms) };
}

describe('ClockBridge', () => {
  it('keeps timestamps steady when the readings jump around by a render buffer', () => {
    // readings alternate between 0 and 10 ms of extra delay
    const { bridge, advance } = bridgeWith((t) => 50 + (Math.floor(t / 40) % 2) * 10);
    const offsets = [];
    for (let i = 0; i < 1500; i++) {
      offsets.push(bridge.getOffset());
      advance(40);
    }
    const spread = Math.max(...offsets.slice(100)) - Math.min(...offsets.slice(100));
    expect(spread).toBeLessThan(1);
  });

  it('starts at the reading, and follows real drift between the clocks', () => {
    // the audio clock runs 50 ppm slow: the offset grows by 0.05 ms per second
    const { bridge, advance } = bridgeWith((t) => 20 + (t - 1000) * 0.00005);
    expect(bridge.getOffset()).toBe(20);
    let offset;
    for (let i = 0; i < 6000; i++) {
      advance(10);
      offset = bridge.getOffset();
    }
    // after 60 s: the true offset is 23 ms; the estimate trails by at most the median window's lag
    expect(offset).toBeGreaterThan(22.7);
    expect(offset).toBeLessThan(23.01);
  });

  it('converts between the clocks with the estimated offset', () => {
    const { bridge } = bridgeWith(() => 100);
    expect(bridge.getPerformanceTime(2)).toBe(2100);
    expect(bridge.getAudioContextTime(2100)).toBe(2);
  });

  it('has no offset before the audio clock reports a time', () => {
    const bridge = new ClockBridge({ getOutputTimestamp: () => ({ performanceTime: 0, contextTime: 0 }) });
    expect(bridge.getPerformanceTime(1)).toBeUndefined();
  });
});
