// EXP-1 (CLI): the reference song renders non-silent, at the right length, bit-identical twice.
import { firstByteDifference, rms } from '../../lib/audio.mjs';
import { REFERENCE, referenceSong } from '../../lib/reference-song.mjs';
import { renderPattern } from '../../lib/render.mjs';

export async function probe({ thresholds, log }) {
  const song = await referenceSong();
  log('render 1/2');
  const a = renderPattern(song, REFERENCE);
  log('render 2/2');
  const b = renderPattern(song, REFERENCE);
  const expectedLength = Math.ceil((REFERENCE.cycles / REFERENCE.cps + REFERENCE.tail) * REFERENCE.sampleRate);
  const diffLeft = firstByteDifference(a.left, b.left);
  const diffRight = firstByteDifference(a.right, b.right);
  const level = rms(a.left);
  const metrics = {
    events: a.eventCount,
    rms: level,
    lengthSamples: a.left.length,
    expectedLength,
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
  if (a.left.length !== expectedLength) return fail(`length ${a.left.length} != ${expectedLength}`, 'wrong length');
  if (diffLeft !== -1 || diffRight !== -1) {
    const first = diffLeft === -1 ? diffRight : diffRight === -1 ? diffLeft : Math.min(diffLeft, diffRight);
    return fail(
      `renders differ from sample ${first} (${(first / REFERENCE.sampleRate).toFixed(3)} s). Suspect: Math.random() in supradough noise/supersaw oscillators`,
      'non-deterministic',
    );
  }
  return { status: 'pass', metrics: { ...metrics, headline: `${a.audioSeconds} s, deterministic` }, notes: {} };
}
