// MIX-1 (browser): a trigger on orbit 2 ducks orbit 1 by at least minDuckDb (superdough duckorbit).
import { renderInPage } from '../../lib/browser/page-render.mjs';
import { duckDrop } from '../../lib/checks.mjs';
import { DUCK, duckPattern } from '../../lib/patterns.mjs';

export async function probe({ page, thresholds }) {
  const out = await renderInPage(page, duckPattern, { cps: DUCK.cps, cycles: 1 });
  const r = duckDrop(out.left, out.sampleRate, DUCK);
  const metrics = { events: out.events, ...r, headline: `${r.dropDb.toFixed(1)} dB duck` };
  const notes = {
    engine: 'superdough',
    renderer: 'renderPatternAudio (OfflineAudioContext)',
    scope: 'ducking only; buses and sends are not separately observable in a stereo mix',
  };
  if (out.events === 0 || !(r.beforeRms > 0)) return { status: 'fail', metrics, notes: { ...notes, error: 'no signal before the trigger' } };
  if (thresholds.minDuckDb == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold minDuckDb missing' } };
  if (!(r.dropDb >= thresholds.minDuckDb)) return { status: 'fail', metrics, notes: { ...notes, error: `ducking ${r.dropDb.toFixed(2)} dB < ${thresholds.minDuckDb} dB` } };
  // Ducking alone doesn't certify the full MIX-1 criterion (4 buses, one send, one ducked bus).
  return { status: 'not-run', metrics, notes: { ...notes, reason: 'partial: ducking verified; 4 buses + send not verified by this probe' } };
}
