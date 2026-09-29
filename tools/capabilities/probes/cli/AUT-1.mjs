// AUT-1 (CLI): gain automation steps land within maxErrorMs of their grid time, with values applied.
import { analyzeSteps } from '../../lib/checks.mjs';
import { AUTOMATION, automationPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const out = renderPattern(automationPattern(), { cps: AUTOMATION.cps, cycles: 1, tail: 0.05 });
  const r = analyzeSteps(out.left, out.sampleRate, AUTOMATION);
  const metrics = { events: out.eventCount, maxErrorMs: r.maxErrorMs, increasing: r.increasing, onsets: r.onsets, headline: `${r.maxErrorMs.toFixed(3)} ms` };
  const notes = { resolution: `stepped: ${AUTOMATION.steps} values per cycle, one per event` };
  if (out.eventCount === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no events rendered' } };
  if (thresholds.maxErrorMs == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold maxErrorMs missing' } };
  if (!r.increasing) return { status: 'fail', metrics, notes: { ...notes, error: 'automated gain values were not applied (levels not rising)' } };
  if (!(r.maxErrorMs <= thresholds.maxErrorMs)) return { status: 'fail', metrics, notes: { ...notes, error: `max timing error ${r.maxErrorMs} ms` } };
  return { status: 'pass', metrics, notes };
}
