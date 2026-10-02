// EXP-1 (browser): the reference song renders offline in the page through renderPatternAudio,
// non-silent; the WAV file it offers for download has the right format and length (read from its
// header and size); and two renders in the same page are the same within maxDiffDbfs.
// Not bit-identical: Chromium sums a node's inputs in an order that can change between renders
// (even three plain OscillatorNodes into one GainNode), and float addition depends on that order.
import { firstByteDifference, rms } from '../../lib/audio.mjs';
import { toDb } from '../../lib/measure.mjs';
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
    wav: a.wav,
  };
  const notes = { renderer: 'renderPatternAudio (superdough, OfflineAudioContext)', scope: 'left channel hashed; render has no tail' };
  const fail = (error, headline) => ({ status: 'fail', metrics: { ...metrics, headline }, notes: { ...notes, error } });
  if (a.events === 0) return fail('no events rendered', 'no events');
  if (!(level >= thresholds.minRms)) {
    const reason = thresholds.minRms == null ? 'threshold minRms missing' : `rms ${level} below ${thresholds.minRms}`;
    return fail(reason, 'silent');
  }
  const wav = a.wav;
  if (!wav?.channels) return fail('renderPatternAudio offered no valid WAV file for download', 'bad WAV');
  if (wav.channels !== 2 || wav.sampleRate !== REFERENCE.sampleRate) {
    return fail(`WAV is ${wav.channels} ch at ${wav.sampleRate} Hz, expected 2 ch at ${REFERENCE.sampleRate} Hz`, 'bad WAV');
  }
  if (wav.frames !== expectedLength) return fail(`WAV length ${wav.frames} != ${expectedLength}`, 'wrong length');
  if (wav.fileBytes !== 44 + wav.dataBytes) return fail(`WAV file is ${wav.fileBytes} bytes, header says ${44 + wav.dataBytes}`, 'bad WAV');
  if (a.length !== b.length) return fail(`render lengths differ: ${a.length} vs ${b.length}`, 'non-deterministic');
  if (thresholds.maxDiffDbfs == null) return fail('threshold maxDiffDbfs missing', 'non-deterministic');
  let maxDiff = 0;
  for (let i = 0; i < a.left.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.left[i] - b.left[i]));
  metrics.maxDiffDbfs = toDb(maxDiff);
  const seconds = a.length / a.sampleRate;
  if (!(metrics.maxDiffDbfs <= thresholds.maxDiffDbfs)) {
    const at = diffLeft >= 0 ? ` from sample ${diffLeft} (${(diffLeft / a.sampleRate).toFixed(3)} s)` : '';
    return fail(`renders differ${at} by up to ${metrics.maxDiffDbfs.toFixed(1)} dBFS (limit ${thresholds.maxDiffDbfs})`, 'non-deterministic');
  }
  const match = diffLeft === -1 ? 'bit-identical' : `repeatable within ${metrics.maxDiffDbfs.toFixed(1)} dBFS`;
  return { status: 'pass', metrics: { ...metrics, headline: `${seconds} s WAV, ${match}` }, notes };
}
