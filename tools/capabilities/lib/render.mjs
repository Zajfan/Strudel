// Offline rendering through supradough, mirroring packages/supradough/dough-export.mjs.
import { Dough } from '../../../packages/supradough/dough.mjs';

export function renderPattern(pattern, { cps = 0.5, cycles, tail = 1, sampleRate = 48000 }) {
  // dough's oscillators assume 48000 in Node (module-level SAMPLE_RATE in dough.mjs)
  if (sampleRate !== 48000) throw new Error(`supradough renders at 48000 Hz in Node, got ${sampleRate}`);
  // slow by 1/cps so that one queried unit is one second, as dough expects
  const songSeconds = cycles / cps;
  const haps = pattern
    .slow(1 / cps)
    .queryArc(0, songSeconds)
    .filter((hap) => hap.hasOnset());
  const dough = new Dough(sampleRate);
  for (const hap of haps) {
    dough.scheduleSpawn({ ...hap.value, _begin: Number(hap.whole.begin), _duration: Number(hap.duration) });
  }
  const length = Math.ceil((songSeconds + tail) * sampleRate);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const start = performance.now();
  for (let i = 0; i < length; i++) {
    dough.update();
    left[i] = dough.out[0];
    right[i] = dough.out[1];
  }
  const renderSeconds = (performance.now() - start) / 1000;
  return { left, right, sampleRate, eventCount: haps.length, audioSeconds: length / sampleRate, renderSeconds };
}
