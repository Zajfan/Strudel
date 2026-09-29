// AUT-1 (browser): gain automation steps land within maxErrorMs of their grid time, with values
// applied, and a continuous ramp within a single held note changes level within the note.
import { renderInPage } from '../../lib/browser/page-render.mjs';
import { analyzeSteps, RAMP_DETECTION_DB, rampWithinNote } from '../../lib/checks.mjs';
import { AUTOMATION, automationPattern, rampPattern } from '../../lib/patterns.mjs';

export async function probe({ page, thresholds }) {
  const out = await renderInPage(page, automationPattern, { cps: AUTOMATION.cps, cycles: 1 });
  const r = analyzeSteps(out.left, out.sampleRate, AUTOMATION);
  const rampOut = await renderInPage(page, rampPattern, { cps: AUTOMATION.cps, cycles: 1 });
  const ramp = rampWithinNote(rampOut.left, rampOut.sampleRate, { cps: AUTOMATION.cps });
  const metrics = {
    events: out.events,
    maxErrorMs: r.maxErrorMs,
    increasing: r.increasing,
    onsets: r.onsets,
    ramp,
    headline: `${r.maxErrorMs.toFixed(3)} ms`,
  };
  const notes = { engine: 'superdough', resolution: `measures onset timing of ${AUTOMATION.steps} stepped values per cycle, one per event` };
  if (out.events === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no events rendered' } };
  if (thresholds.maxErrorMs == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold maxErrorMs missing' } };
  if (!r.increasing) return { status: 'fail', metrics, notes: { ...notes, error: 'automated gain values were not applied (levels not rising)' } };
  if (!(r.maxErrorMs <= thresholds.maxErrorMs)) return { status: 'fail', metrics, notes: { ...notes, error: `max timing error ${r.maxErrorMs} ms` } };
  if (!(ramp.changeDb >= RAMP_DETECTION_DB)) {
    return {
      status: 'fail',
      metrics: { ...metrics, headline: 'stepped only' },
      notes: { ...notes, error: 'automation is sampled once per event; no continuous ramp within a held note' },
    };
  }
  return { status: 'pass', metrics, notes };
}
