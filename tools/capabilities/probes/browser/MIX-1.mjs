// MIX-1 (browser): during LIVE playback, a trigger on orbit 2 ducks orbit 1 by at least minDuckDb
// (superdough duckorbit). The master mix is recorded sample-accurately with an AudioWorklet tap;
// the drop is measured around each orbit-2 oscillator start and the median is reported. The
// offline export (renderPatternAudio) is measured too, as an extra export-fidelity metric.
import { recordLive } from '../../lib/browser/page-recorder.mjs';
import { renderInPage } from '../../lib/browser/page-render.mjs';
import { withMiniStrings } from '../../lib/browser/page-scope.mjs';
import { duckDrop, duckDropAt } from '../../lib/checks.mjs';
import { DUCK, duckPattern } from '../../lib/patterns.mjs';

const RECORD_SECONDS = 3;
const TRIGGER_FREQ = 440 * Math.pow(2, (72 - 69) / 12); // duckPattern's orbit-2 trigger is note 72

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export async function probe({ page, thresholds }) {
  // Tempo is set in the REPL code with setcps(DUCK.cps), the same way a user would.
  const code = `setcps(${DUCK.cps});\n(${duckPattern.toString()})();`;
  const live = await withMiniStrings(page, () => recordLive(page, code, { seconds: RECORD_SECONDS }));
  const { left, sampleRate, startFrame } = live;
  const before = Math.round(0.05 * sampleRate);
  const after = Math.round(0.025 * sampleRate);
  const triggers = live.starts
    .filter((s) => Math.abs(s.freq - TRIGGER_FREQ) < 1)
    .map((s) => Math.round(s.when * sampleRate) - startFrame)
    .filter((i) => i - before >= 0 && i + after <= left.length);
  const drops = triggers.map((i) => ({ at: i, ...duckDropAt(left, sampleRate, i) }));
  const dropDb = drops.length ? median(drops.map((d) => d.dropDb)) : NaN;
  const beforeRms = drops.length ? median(drops.map((d) => d.beforeRms)) : 0;

  // Offline export (renderPatternAudio) for comparison: it closes the live context, so it runs last.
  const offline = await renderInPage(page, duckPattern, { cps: DUCK.cps, cycles: 1 });
  const offlineDropDb = duckDrop(offline.left, offline.sampleRate, DUCK).dropDb;

  const metrics = {
    triggers: drops.length,
    drops: drops.map((d) => ({ atSample: d.at, beforeRms: d.beforeRms, afterRms: d.afterRms, dropDb: d.dropDb })),
    dropDb,
    beforeRms,
    recordedSamples: left.length,
    sampleRate,
    offlineDropDb,
    headline: Number.isFinite(dropDb) ? `${dropDb.toFixed(1)} dB duck (live)` : 'no trigger',
  };
  const notes = {
    engine: 'superdough',
    scope: 'live playback in headless Chromium with a fake audio device; ducking only, buses and sends are not separately observable in a stereo mix',
    tap: `AudioWorklet recorder on ${live.tap} (master mix, channel 0); median drop over orbit-2 trigger starts; tempo via setcps(${DUCK.cps}) in the REPL code`,
    offlineExport:
      'renderPatternAudio renders in 1-cycle chunks and superdough fires duck() from a main-thread webAudioTimeout callback, so in an export the duck lands wherever the main thread catches up (at chunk boundaries, or past the render) instead of at the trigger; offlineDropDb therefore varies from run to run',
  };
  if (live.error) return { status: 'fail', metrics, notes: { ...notes, error: live.error } };
  if (!drops.length) return { status: 'fail', metrics, notes: { ...notes, error: 'no orbit-2 trigger starts recorded inside the capture' } };
  if (!(beforeRms > 0)) return { status: 'fail', metrics, notes: { ...notes, error: 'no signal before the trigger' } };
  if (thresholds.minDuckDb == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold minDuckDb missing' } };
  if (!(dropDb >= thresholds.minDuckDb)) return { status: 'fail', metrics, notes: { ...notes, error: `ducking ${dropDb.toFixed(2)} dB < ${thresholds.minDuckDb} dB` } };
  // Ducking alone doesn't certify the full MIX-1 criterion (4 buses, one send, one ducked bus).
  return { status: 'not-run', metrics, notes: { ...notes, reason: 'partial: ducking verified; 4 buses + send not verified by this probe' } };
}
