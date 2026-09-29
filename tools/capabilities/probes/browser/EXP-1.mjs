// EXP-1 (browser): the reference song renders offline in the page through renderPatternAudio,
// non-silent, at the right length, bit-identical twice in the same page.
import { firstByteDifference, rms } from '../../lib/audio.mjs';
import { renderInPage } from '../../lib/browser/page-render.mjs';
import { buildReferenceSong, REFERENCE } from '../../lib/reference-song.mjs';

const RENDER_TIMEOUT_MS = 600000;

export async function probe({ page, thresholds, log }) {
  const opts = { cps: REFERENCE.cps, cycles: REFERENCE.cycles, sampleRate: REFERENCE.sampleRate, timeoutMs: RENDER_TIMEOUT_MS };
  log('render 1/2');
  const a = await renderInPage(page, buildReferenceSong, opts);
  log('render 2/2');
  const b = await renderInPage(page, buildReferenceSong, opts);
  // renderPatternAudio sizes its OfflineAudioContext as (end - begin) / cps * sampleRate, with no tail.
  const expectedLength = Math.floor((REFERENCE.cycles / REFERENCE.cps) * REFERENCE.sampleRate);
  const level = rms(a.left);
  const diffLeft = firstByteDifference(a.left, b.left);
  const metrics = {
    events: a.events,
    rms: level,
    lengthSamples: a.length,
    expectedLength,
    secondLength: b.length,
    hashes: [a.hash, b.hash],
    firstDifferenceLeft: diffLeft,
    channels: a.channels,
  };
  const notes = { renderer: 'renderPatternAudio (superdough, OfflineAudioContext)', scope: 'left channel hashed; render has no tail' };
  const fail = (error, headline) => ({ status: 'fail', metrics: { ...metrics, headline }, notes: { ...notes, error } });
  if (a.events === 0) return fail('no events rendered', 'no events');
  if (!(level >= thresholds.minRms)) {
    const reason = thresholds.minRms == null ? 'threshold minRms missing' : `rms ${level} below ${thresholds.minRms}`;
    return fail(reason, 'silent');
  }
  if (a.length !== expectedLength) return fail(`length ${a.length} != ${expectedLength}`, 'wrong length');
  if (a.length !== b.length || a.hash !== b.hash || diffLeft !== -1) {
    const at = diffLeft >= 0 ? ` from sample ${diffLeft} (${(diffLeft / a.sampleRate).toFixed(3)} s)` : '';
    return fail(`renders differ${at}: length ${a.length} vs ${b.length}, FNV-1a ${a.hash} vs ${b.hash}`, 'non-deterministic');
  }
  const seconds = a.length / a.sampleRate;
  return { status: 'pass', metrics: { ...metrics, headline: `${seconds} s, deterministic` }, notes };
}
