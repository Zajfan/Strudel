// TUNE-1 (CLI): 19-EDO and just intonation in pattern code; pattern and rendered pitch within maxCents.
import { checkTuning } from '../../lib/checks.mjs';
import { cents, estimateFrequency } from '../../lib/measure.mjs';
import { TUNING_RENDER_EXPECTED, tuningCases, tuningRenderPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const cases = tuningCases().map(({ name, pattern, expected }) => {
    const values = pattern.queryArc(0, 1).map((h) => h.value);
    return { name, ...checkTuning(values, expected) };
  });
  const out = renderPattern(tuningRenderPattern(), { cps: 1, cycles: 1, tail: 0 });
  const measured = estimateFrequency(out.left, out.sampleRate, 4800, 43200);
  const renderedCents = Math.abs(cents(measured, TUNING_RENDER_EXPECTED));
  const worst = Math.max(...cases.map((c) => c.maxCents), renderedCents);
  const metrics = { cases, renderedFreq: measured, renderedCents, maxCents: worst };
  if (thresholds.maxCents == null) return { status: 'fail', metrics, notes: { error: 'threshold maxCents missing' } };
  if (!(worst <= thresholds.maxCents)) {
    return { status: 'fail', metrics: { ...metrics, headline: `${worst.toFixed(2)} cents off` }, notes: { error: `max deviation ${worst} > ${thresholds.maxCents} cents` } };
  }
  return { status: 'pass', metrics: { ...metrics, headline: `max ${worst.toFixed(3)} cents` }, notes: {} };
}
