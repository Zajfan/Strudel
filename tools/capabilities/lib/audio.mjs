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

// Reads the format of a canonical 44-byte-header WAV file (RIFF, one 'fmt ' chunk of 16 bytes, then
// 'data'), as written by supradough's encodeWav and superdough's audioBufferToWav. Returns null for
// anything else. `frames` comes from the data chunk's size, so it is the length the file claims.
export function parseWavHeader(bytes) {
  if (!bytes || bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE' || text(12) !== 'fmt ' || text(36) !== 'data') return null;
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const frames = dataBytes / (channels * (bitsPerSample / 8));
  return { format, channels, sampleRate, bitsPerSample, dataBytes, frames };
}
