// ARR-1 (browser): an 8-section, 64-bar arrangement queried in the page, with correct boundaries
// and a hard ending.
import { checkArrangement } from '../../lib/checks.mjs';
import { ARRANGEMENT, arrangementPattern } from '../../lib/patterns.mjs';

export async function probe({ page }) {
  const { sections, bars } = ARRANGEMENT;
  const pairs = await page.evaluate(
    ({ builderSource, end }) =>
      (0, eval)(`(${builderSource})`)()
        .queryArc(0, end)
        .filter((h) => h.hasOnset())
        .map((h) => [Number(h.whole.begin), h.value.note]),
    { builderSource: arrangementPattern.toString(), end: sections * bars + bars },
  );
  const haps = pairs.map(([begin, note]) => ({ whole: { begin }, value: { note } }));
  const r = checkArrangement(haps, ARRANGEMENT);
  const metrics = { sections, bars: sections * bars, ...r };
  const notes = { construct: 'arrange()' };
  if (r.eventsInSong === 0) return { status: 'fail', metrics: { ...metrics, headline: 'no events' }, notes };
  if (r.wrongSection > 0) {
    return { status: 'fail', metrics: { ...metrics, headline: 'wrong boundaries' }, notes: { ...notes, error: `${r.wrongSection} events in the wrong section` } };
  }
  if (r.eventsAfterEnd > 0) {
    return {
      status: 'fail',
      metrics: { ...metrics, headline: 'no hard ending' },
      notes: { ...notes, error: `arrange() loops: ${r.eventsAfterEnd} events after bar ${sections * bars}` },
    };
  }
  return { status: 'pass', metrics: { ...metrics, headline: `${sections} sections, ${sections * bars} bars` }, notes };
}
