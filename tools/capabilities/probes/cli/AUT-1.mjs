// AUT-1 (CLI): gain automation steps land within maxErrorMs of their grid time, with values applied,
// and a continuous ramp within a single held note actually changes level within the note.
import { analyzeSteps, RAMP_DETECTION_DB, rampWithinNote } from '../../lib/checks.mjs';
import { AUTOMATION, automationPattern, rampPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const out = renderPattern(automationPattern(), { cps: AUTOMATION.cps, cycles: 1, tail: 0.05 });
  const r = analyzeSteps(out.left, out.sampleRate, AUTOMATION);
  const rampOut = renderPattern(rampPattern(), { cps: AUTOMATION.cps, cycles: 1, tail: 0 });
  const ramp = rampWithinNote(rampOut.left, rampOut.sampleRate, { cps: AUTOMATION.cps });
  const metrics = {
    events: out.eventCount,
    maxErrorMs: r.maxErrorMs,
    increasing: r.increasing,
    onsets: r.onsets,
    ramp,
    headline: `${r.maxErrorMs.toFixed(3)} ms`,
  };
  const notes = { resolution: `measures onset timing of ${AUTOMATION.steps} stepped values per cycle, one per event` };
  if (out.eventCount === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no events rendered' } };
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
  // The stepped checks passed and a continuous ramp is present, but this probe only times the
  // stepped onsets: the ramp's own timing error is not measured, so the cell cannot pass yet.
  return {
    status: 'not-run',
    metrics: { ...metrics, headline: `${r.maxErrorMs.toFixed(3)} ms stepped; ramp untimed` },
    notes: { ...notes, reason: 'partial: continuous ramp present; ramp timing not measured' },
  };
}
