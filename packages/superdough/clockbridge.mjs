/*
clockbridge.mjs
Copyright (C) 2022 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/superdough/index.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// thanks freya https://youtu.be/LSNQuFEDOyQ?si=ukZI2IGgWV_NDZzP&t=2979
export function expDecay(a, b, decay, dt) {
  return b + (a - b) * Math.exp(-decay * dt);
}

// How the offset between the clocks is estimated. getOutputTimestamp() is noisy: readings jump by
// several ms (a render buffer or more), especially for the first seconds after audio starts. MIDI
// and OSC timestamps carry the offset, so every move of the estimate shows up as timing jitter (a
// clock out at a steady tempo would wobble). So the estimate starts at the median of the readings,
// and then only slews toward the median of the last WINDOW_MS of readings by at most MAX_SLEW
// ms per second: enough to follow real drift between the audio and system clocks (< 100 ppm),
// slow enough to keep timestamps steady. Measured on headless Chromium, clock-out jitter went from
// 6.8 ms (exponential smoothing with a 10 s time constant) to under 1 ms.
const WINDOW_MS = 5000;
const SAMPLE_EVERY_MS = 20; // readings closer together than this add nothing
const MAX_SLEW = 0.1; // ms of offset change per second
// A reading describes the sound being output about now. WebKitGTK's performanceTime runs at twice
// real speed (measured: 5.0 s after 2.5 s), which would put MIDI and OSC events seconds late; a
// reading further than this from now is replaced by currentTime plus the reported output latency.
const MAX_TIMESTAMP_SKEW_MS = 500;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

// translates between audio and performance clock
export class ClockBridge {
  p; // estimated clock offset in ms
  lastTime;
  readings = []; // [performanceTime, offset] of the last WINDOW_MS
  audioContext;
  // now: the performance clock in ms (injectable for tests)
  constructor(audioContext, now = () => performance.now()) {
    this.audioContext = audioContext;
    this.now = now;
  }
  // a [contextTime (s), performanceTime (ms)] pair, or undefined while the audio clock isn't running
  reading() {
    const ac = this.audioContext;
    let { contextTime, performanceTime } = ac.getOutputTimestamp?.() ?? {};
    const now = this.now();
    if (contextTime > 0 && performanceTime > 0 && Math.abs(performanceTime - now) <= MAX_TIMESTAMP_SKEW_MS) {
      return [contextTime, performanceTime];
    }
    if (ac.currentTime > 0) {
      const latencyMs = ((ac.outputLatency || 0) + (ac.baseLatency || 0)) * 1000;
      return [ac.currentTime, now + latencyMs];
    }
    return undefined;
  }
  // delta between audio and performance time in ms
  getOffset() {
    const reading = this.reading();
    if (!reading) {
      return this.p;
    }
    const [contextTime, performanceTime] = reading;
    const offset = performanceTime - contextTime * 1000; // clock offset in ms
    const lastReading = this.readings.at(-1);
    if (!lastReading || performanceTime - lastReading[0] >= SAMPLE_EVERY_MS) {
      this.readings.push([performanceTime, offset]);
      while (performanceTime - this.readings[0][0] > WINDOW_MS) {
        this.readings.shift();
      }
    }
    const target = median(this.readings.map(([, o]) => o));
    if (this.p === undefined) {
      this.p = target;
    } else {
      const maxStep = (MAX_SLEW * Math.max(0, performanceTime - this.lastTime)) / 1000;
      this.p += Math.max(-maxStep, Math.min(maxStep, target - this.p));
    }
    this.lastTime = performanceTime;
    return this.p;
  }
  getPerformanceTime(audioContextTime) {
    const offset = this.getOffset();
    if (offset === undefined) {
      return undefined;
    }
    return audioContextTime * 1000 + offset; // this is now correct in performance time (ms)
  }
  getAudioContextTime(performanceTime) {
    const offset = this.getOffset();
    if (offset === undefined) {
      return undefined;
    }
    return (performanceTime - offset) / 1000; // this is now correct in audio context time (seconds)
  }
}
