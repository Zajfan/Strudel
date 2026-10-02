/*
render.mjs - offline rendering of patterns through dough, without Web Audio (e.g. in Node)
Copyright (C) 2025 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/supradough/render.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Dough } from './dough.mjs';

// Renders `cycles` cycles of the pattern plus `tail` seconds of release. `seed` makes noise and
// oscillator phases reproducible, so the same arguments give the same samples. Calls onSample(dough)
// after every sample. Returns the number of samples, of rendered events, and the seconds spent
// rendering samples (without querying the pattern).
function renderWith(pattern, { cps = 0.5, cycles, tail = 1, sampleRate = 48000, seed = 0 }, onSample) {
  if (!(cycles > 0)) {
    throw new Error(`render: cycles must be a positive number, got ${cycles}`);
  }
  // dough's oscillators assume 48000 outside a worklet (module-level SAMPLE_RATE in dough.mjs)
  if (sampleRate !== 48000) {
    throw new Error(`render: dough renders at 48000 Hz outside a worklet, got ${sampleRate}`);
  }
  // slow by 1/cps so that one queried unit is one second, as dough expects
  const songSeconds = cycles / cps;
  const haps = pattern
    .slow(1 / cps)
    .queryArc(0, songSeconds)
    .filter((hap) => hap.hasOnset());
  const dough = new Dough(sampleRate, 0, seed);
  for (const hap of haps) {
    dough.scheduleSpawn({ ...hap.value, _begin: Number(hap.whole.begin), _duration: Number(hap.duration) });
  }
  const length = Math.ceil((songSeconds + tail) * sampleRate);
  const start = performance.now();
  for (let i = 0; i < length; i++) {
    dough.update();
    onSample(dough, i);
  }
  return { length, eventCount: haps.length, renderSeconds: (performance.now() - start) / 1000 };
}

/**
 * Renders the pattern to stereo samples.
 * @returns {{ left: Float32Array, right: Float32Array, sampleRate: number, eventCount: number, renderSeconds: number }}
 */
export function renderDough(pattern, options) {
  const sampleRate = options.sampleRate ?? 48000;
  const length = Math.ceil(((options.cycles ?? 0) / (options.cps ?? 0.5) + (options.tail ?? 1)) * sampleRate);
  const left = new Float32Array(Math.max(0, length));
  const right = new Float32Array(Math.max(0, length));
  const { eventCount, renderSeconds } = renderWith(pattern, options, (dough, i) => {
    left[i] = dough.out[0];
    right[i] = dough.out[1];
  });
  return { left, right, sampleRate, eventCount, renderSeconds };
}

/**
 * Renders the pattern once and returns the mix plus one stereo stem per orbit, with each orbit's
 * delay in its own stem. The stems add up to the mix.
 * @returns {{ mix: { left, right }, stems: Map<number, { left: Float32Array, right: Float32Array }>, sampleRate, eventCount }}
 */
export function renderDoughStems(pattern, options) {
  const sampleRate = options.sampleRate ?? 48000;
  const length = Math.ceil(((options.cycles ?? 0) / (options.cps ?? 0.5) + (options.tail ?? 1)) * sampleRate);
  const stereo = () => ({ left: new Float32Array(Math.max(0, length)), right: new Float32Array(Math.max(0, length)) });
  const mix = stereo();
  const stems = new Map();
  const { eventCount } = renderWith(pattern, options, (dough, i) => {
    mix.left[i] = dough.out[0];
    mix.right[i] = dough.out[1];
    for (const [orbit, bus] of dough.orbits) {
      let stem = stems.get(orbit);
      if (!stem) {
        stem = stereo();
        stems.set(orbit, stem);
      }
      stem.left[i] = bus.out[0];
      stem.right[i] = bus.out[1];
    }
  });
  return { mix, stems: new Map([...stems].sort(([a], [b]) => a - b)), sampleRate, eventCount };
}

/**
 * Encodes stereo or mono samples as a WAV file: 16-bit PCM, or 32-bit float with `float: true`.
 * @param {Float32Array[]} channels one array of samples per channel, all the same length
 * @returns {Uint8Array} the WAV file's bytes
 */
export function encodeWav(channels, sampleRate, { float = false } = {}) {
  const frames = channels[0]?.length ?? 0;
  if (channels.some((c) => c.length !== frames)) {
    throw new Error('encodeWav: channels differ in length');
  }
  const bytesPerSample = float ? 4 : 2;
  const blockAlign = channels.length * bytesPerSample;
  const dataSize = frames * blockAlign;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, float ? 3 : 1, true); // 3: IEEE float, 1: PCM
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  text(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      if (float) {
        view.setFloat32(offset, channel[i], true);
      } else {
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      }
      offset += bytesPerSample;
    }
  }
  return new Uint8Array(view.buffer);
}
