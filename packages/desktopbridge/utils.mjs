import { invoke } from '@tauri-apps/api/core';
import { getEventOffsetMs } from '@strudel/core';
import { getClockBridge } from '@strudel/webaudio';

export const Invoke = invoke;
// __TAURI_INTERNALS__ in Tauri 2, __TAURI_IPC__ in Tauri 1
export const isTauri = () => window.__TAURI_INTERNALS__ != null || window.__TAURI_IPC__ != null;

// When a sound at audio time `targetTime` is heard, as a Unix-epoch time in ms: the clock the Rust
// side reads too (SystemTime), so messages are scheduled at absolute times and the delay of
// setTimeout and IPC doesn't move them. Falls back to an offset from now while the clock bridge
// has no reading yet.
export const toEpochMs = (targetTime, currentTime) => {
  const performanceTime = getClockBridge().getPerformanceTime(targetTime);
  const now = performance.timeOrigin + performance.now();
  return performanceTime === undefined ? now + getEventOffsetMs(targetTime, currentTime) : performance.timeOrigin + performanceTime;
};
