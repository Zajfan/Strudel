// Measurements on rendered sample buffers.
export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// Compares bit patterns, so -0 vs 0 and differing NaN payloads count as differences.
export function firstByteDifference(a, b) {
  if (a.length !== b.length) return 0;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return i;
  }
  return -1;
}
