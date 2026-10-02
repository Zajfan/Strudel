// EXP-1 (CLI): the reference song renders non-silent and is encoded to WAV; the WAV has the right
// format and length (read from its header), and two renders give byte-identical WAV files.
import { firstByteDifference, parseWavHeader, rms } from '../../lib/audio.mjs';
import { encodeWav } from '../../../../packages/supradough/render.mjs';
import { REFERENCE, referenceSong } from '../../lib/reference-song.mjs';
import { renderPattern } from '../../lib/render.mjs';

export async function probe({ thresholds, log }) {
  const song = await referenceSong();
  log('render 1/2');
  const a = renderPattern(song, REFERENCE);
  log('render 2/2');
  const b = renderPattern(song, REFERENCE);
  // the song is 32 cycles at 0.5 cps (64 s) plus a 1 s release tail
  const expectedLength = Math.ceil((REFERENCE.cycles / REFERENCE.cps + REFERENCE.tail) * REFERENCE.sampleRate);
  const wavA = encodeWav([a.left, a.right], REFERENCE.sampleRate);
  const wavB = encodeWav([b.left, b.right], REFERENCE.sampleRate);
  const wav = parseWavHeader(wavA);
  const diffLeft = firstByteDifference(a.left, b.left);
  const diffRight = firstByteDifference(a.right, b.right);
  const wavIdentical = wavA.length === wavB.length && wavA.every((byte, i) => byte === wavB[i]);
  const level = rms(a.left);
  const metrics = {
    events: a.eventCount,
    rms: level,
    lengthSamples: wav?.frames,
    expectedLength,
    wav: wav && { channels: wav.channels, sampleRate: wav.sampleRate, bitsPerSample: wav.bitsPerSample, bytes: wavA.length },
    wavIdentical,
    firstDifferenceLeft: diffLeft,
    firstDifferenceRight: diffRight,
  };
  const fail = (error, headline) => ({ status: 'fail', metrics: { ...metrics, headline }, notes: { error } });
  if (a.eventCount === 0) return fail('no events rendered', 'no events');
  if (!(level >= thresholds.minRms)) {
    const reason =
      thresholds.minRms == null ? 'threshold minRms missing' : `rms ${level} below ${thresholds.minRms}`;
    return fail(reason, 'silent');
  }
  if (!wav) return fail('the encoded WAV has no valid header', 'bad WAV');
  if (wav.channels !== 2 || wav.sampleRate !== REFERENCE.sampleRate) {
    return fail(`WAV is ${wav.channels} ch at ${wav.sampleRate} Hz, expected 2 ch at ${REFERENCE.sampleRate} Hz`, 'bad WAV');
  }
  if (wav.frames !== expectedLength) return fail(`WAV length ${wav.frames} != ${expectedLength}`, 'wrong length');
  if (!wavIdentical || diffLeft !== -1 || diffRight !== -1) {
    const first = diffLeft === -1 ? diffRight : diffRight === -1 ? diffLeft : Math.min(diffLeft, diffRight);
    return fail(
      `renders differ from sample ${first} (${(first / REFERENCE.sampleRate).toFixed(3)} s). Suspect: unseeded randomness in the renderer`,
      'non-deterministic',
    );
  }
  return { status: 'pass', metrics: { ...metrics, headline: `${a.audioSeconds} s WAV, byte-identical` }, notes: {} };
}
