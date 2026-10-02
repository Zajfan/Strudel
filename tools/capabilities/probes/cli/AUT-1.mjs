// AUT-1 (CLI): gain automation steps land within maxErrorMs of their grid time, with values applied,
// and a continuous ramp within a single held note (`auto`) follows its expected course within
// maxErrorMs: measured per period of a 1 kHz tone and mapped back to gain through a calibration
// render (calibrateGain, rampTiming), so the engine's gain law doesn't matter.
import { analyzeSteps, calibrateGain, rampTiming } from '../../lib/checks.mjs';
import { AUTOMATION, RAMP, automationPattern, calibrationPattern, rampPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const out = renderPattern(automationPattern(), { cps: AUTOMATION.cps, cycles: 1, tail: 0.05 });
  const r = analyzeSteps(out.left, out.sampleRate, AUTOMATION);
  const period = out.sampleRate / RAMP.freq;
  const cal = renderPattern(calibrationPattern(), { cps: RAMP.cps, cycles: RAMP.calibrationCycles, tail: 0 });
  const calibration = calibrateGain(cal.left, cal.sampleRate, {
    steps: RAMP.calibrationSteps,
    seconds: RAMP.calibrationCycles / RAMP.cps,
    from: RAMP.from,
    to: RAMP.to,
    period,
  });
  const rampOut = renderPattern(rampPattern(), { cps: RAMP.cps, cycles: 1, tail: 0 });
  const ramp = rampTiming(rampOut.left, rampOut.sampleRate, { begin: 0, duration: 1 / RAMP.cps, from: RAMP.from, to: RAMP.to, period }, calibration);
  const metrics = {
    events: out.eventCount,
    maxErrorMs: r.maxErrorMs,
    increasing: r.increasing,
    onsets: r.onsets,
    ramp,
    headline: `${r.maxErrorMs.toFixed(3)} ms stepped, ${ramp.maxErrorMs.toFixed(3)} ms ramp`,
  };
  const notes = {
    resolution: `onset timing of ${AUTOMATION.steps} stepped values per cycle; ramp timing per 1 ms period of a 1 kHz tone`,
    ramp: 'gain automated 0.1 -> 1 over one held note with auto(saw.range(0.1, 1))',
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (out.eventCount === 0) return fail('no events rendered');
  if (thresholds.maxErrorMs == null) return fail('threshold maxErrorMs missing');
  if (!r.increasing) return fail('automated gain values were not applied (levels not rising)');
  if (!(r.maxErrorMs <= thresholds.maxErrorMs)) return fail(`max stepped timing error ${r.maxErrorMs} ms`);
  if (!(ramp.windows > 0)) return fail('no ramp measured');
  if (!(ramp.maxErrorMs <= thresholds.maxErrorMs)) return fail(`max ramp timing error ${ramp.maxErrorMs.toFixed(3)} ms`);
  return { status: 'pass', metrics, notes };
}
