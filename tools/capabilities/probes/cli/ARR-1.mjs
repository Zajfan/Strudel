// ARR-1 (CLI): an 8-section, 64-bar arrangement with correct boundaries and a hard ending.
import { checkArrangement } from '../../lib/checks.mjs';
import { ARRANGEMENT, arrangementPattern } from '../../lib/patterns.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe() {
  await loadScope();
  const { sections, bars } = ARRANGEMENT;
  const haps = arrangementPattern()
    .queryArc(0, sections * bars + bars)
    .filter((h) => h.hasOnset());
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
