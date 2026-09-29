// Audio measurements shared by CLI and browser probes.
export function firstIndexAbove(samples, threshold, from = 0, to = samples.length) {
  for (let i = Math.max(0, from); i < Math.min(to, samples.length); i++) {
    if (Math.abs(samples[i]) > threshold) return i;
  }
  return -1;
}

export function windowRms(samples, start, end) {
  const a = Math.max(0, Math.floor(start));
  const b = Math.min(samples.length, Math.floor(end));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}

export const toDb = (ratio) => (ratio > 0 ? 20 * Math.log10(ratio) : -Infinity);

export const cents = (freq, ref) => 1200 * Math.log2(freq / ref);

// Rising zero crossings with linear interpolation between samples.
export function estimateFrequency(samples, sampleRate, start, end) {
  const crossings = [];
  for (let i = Math.max(1, start); i < Math.min(end, samples.length); i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a < 0 && b >= 0) crossings.push(i - 1 + a / (a - b));
  }
  if (crossings.length < 2) return NaN;
  const periods = crossings.length - 1;
  return (periods * sampleRate) / (crossings.at(-1) - crossings[0]);
}

export function decodeFloat32(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
}
