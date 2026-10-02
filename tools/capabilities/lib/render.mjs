// Offline rendering for the CLI probes, through supradough's render API (packages/supradough/render.mjs).
import { renderDough } from '../../../packages/supradough/render.mjs';

export function renderPattern(pattern, { cps = 0.5, cycles, tail = 1, sampleRate = 48000 }) {
  // seeded (the default): offline renders must be reproducible. renderSeconds covers only the
  // sample loop, not querying the pattern.
  const { left, right, eventCount, renderSeconds } = renderDough(pattern, { cps, cycles, tail, sampleRate });
  return { left, right, sampleRate, eventCount, audioSeconds: left.length / sampleRate, renderSeconds };
}
