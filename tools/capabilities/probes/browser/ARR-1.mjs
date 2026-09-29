// ARR-1 (browser): an 8-section, 64-bar arrangement queried in the page, with correct boundaries
// and a hard ending. Every candidate construct (bare arrange(), and arrange() cut off at bar 64)
// is checked; the cell passes if any one of them gives the right sections and nothing after the end.
import { checkArrangement, judgeArrangement } from '../../lib/checks.mjs';
import { ARRANGEMENT, arrangementCandidates } from '../../lib/patterns.mjs';

export async function probe({ page }) {
  const { sections, bars } = ARRANGEMENT;
  const raw = await page.evaluate(
    ({ builderSource, end }) =>
      (0, eval)(`(${builderSource})`)().map(({ name, pattern }) => ({
        name,
        pairs: pattern
          .queryArc(0, end)
          .filter((h) => h.hasOnset())
          .map((h) => [Number(h.whole.begin), h.value.note]),
      })),
    { builderSource: arrangementCandidates.toString(), end: sections * bars + bars },
  );
  const candidates = raw.map(({ name, pairs }) => {
    const haps = pairs.map(([begin, note]) => ({ whole: { begin }, value: { note } }));
    return { name, ...checkArrangement(haps, ARRANGEMENT) };
  });
  return judgeArrangement(candidates, ARRANGEMENT);
}
