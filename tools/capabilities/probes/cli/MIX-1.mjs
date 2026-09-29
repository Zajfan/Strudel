// MIX-1 (CLI): a trigger on orbit 2 ducks orbit 1 by at least minDuckDb.
import { duckDrop } from '../../lib/checks.mjs';
import { DUCK, duckPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const out = renderPattern(duckPattern(), { cps: DUCK.cps, cycles: 1, tail: 0 });
  const r = duckDrop(out.left, out.sampleRate, DUCK);
  const metrics = { events: out.eventCount, ...r, headline: `${r.dropDb.toFixed(1)} dB duck` };
  const notes = { engine: 'supradough', scope: 'ducking only; buses and sends are not separately observable in a stereo mix' };
  if (out.eventCount === 0 || r.beforeRms === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no signal before the trigger' } };
  if (thresholds.minDuckDb == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold minDuckDb missing' } };
  if (!(r.dropDb >= thresholds.minDuckDb)) return { status: 'fail', metrics, notes: { ...notes, error: `ducking ${r.dropDb.toFixed(2)} dB < ${thresholds.minDuckDb} dB` } };
  // Ducking alone doesn't certify the full MIX-1 criterion (4 buses, one send, one ducked bus);
  // this probe only measures the duck depth, so it can never report a full pass.
  return { status: 'not-run', metrics, notes: { ...notes, reason: 'partial: ducking verified; 4 buses + send not verified by this probe' } };
}
