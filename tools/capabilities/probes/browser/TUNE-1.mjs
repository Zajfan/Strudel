// TUNE-1 (browser): 19-EDO and just intonation in pattern code in the page; pattern values and
// rendered pitch within maxCents.
import { renderInPage } from '../../lib/browser/page-render.mjs';
import { checkTuning } from '../../lib/checks.mjs';
import { cents, estimateFrequency } from '../../lib/measure.mjs';
import { TUNING_RENDER_EXPECTED, tuningCases, tuningRenderPattern } from '../../lib/patterns.mjs';

export async function probe({ page, thresholds }) {
  const raw = await page.evaluate((builderSource) => {
    const build = (0, eval)(`(${builderSource})`);
    return build().map(({ name, pattern, expected }) => ({
      name,
      values: pattern.queryArc(0, 1).map((h) => h.value),
      expected,
    }));
  }, tuningCases.toString());
  const cases = raw.map(({ name, values, expected }) => ({ name, ...checkTuning(values, expected) }));
  const out = await renderInPage(page, tuningRenderPattern, { cps: 1, cycles: 1 });
  const measured = estimateFrequency(out.left, out.sampleRate, 4800, 43200);
  const renderedCents = Math.abs(cents(measured, TUNING_RENDER_EXPECTED));
  const worst = Math.max(...cases.map((c) => c.maxCents), renderedCents);
  const metrics = { cases, renderedFreq: measured, renderedCents, maxCents: worst };
  const notes = { engine: 'superdough' };
  if (out.events === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no events rendered' } };
  if (thresholds.maxCents == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold maxCents missing' } };
  if (!(worst <= thresholds.maxCents)) {
    return { status: 'fail', metrics: { ...metrics, headline: `${worst.toFixed(2)} cents off` }, notes: { ...notes, error: `max deviation ${worst} > ${thresholds.maxCents} cents` } };
  }
  return { status: 'pass', metrics: { ...metrics, headline: `max ${worst.toFixed(3)} cents` }, notes };
}
