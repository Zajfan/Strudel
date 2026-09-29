// PERF-1 (CLI): the reference song renders at least minRealtimeFactor times faster than real time.
import { rms } from '../../lib/audio.mjs';
import { REFERENCE, referenceSong } from '../../lib/reference-song.mjs';
import { renderPattern } from '../../lib/render.mjs';

export async function probe({ thresholds }) {
  const song = await referenceSong();
  const out = renderPattern(song, REFERENCE);
  const factor = out.audioSeconds / out.renderSeconds;
  const metrics = {
    events: out.eventCount,
    audioSeconds: out.audioSeconds,
    renderSeconds: out.renderSeconds,
    realtimeFactor: factor,
    headline: `${factor.toFixed(1)}x real time`,
  };
  if (out.eventCount === 0 || rms(out.left) === 0) {
    return { status: 'fail', metrics, notes: { error: 'no events or silent render; speed is meaningless' } };
  }
  if (factor < thresholds.minRealtimeFactor) {
    return { status: 'fail', metrics, notes: { error: `${factor.toFixed(2)}x < ${thresholds.minRealtimeFactor}x` } };
  }
  return { status: 'pass', metrics, notes: {} };
}
