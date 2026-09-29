// ARR-1 (CLI): an 8-section, 64-bar arrangement with correct boundaries and a hard ending. Every
// candidate construct (bare arrange(), and arrange() cut off at bar 64) is checked; the cell
// passes if any one of them gives the right sections and nothing after the end.
import { checkArrangement, judgeArrangement } from '../../lib/checks.mjs';
import { ARRANGEMENT, arrangementCandidates } from '../../lib/patterns.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe() {
  await loadScope();
  const { sections, bars } = ARRANGEMENT;
  const candidates = arrangementCandidates().map(({ name, pattern }) => {
    const haps = pattern.queryArc(0, sections * bars + bars).filter((h) => h.hasOnset());
    return { name, ...checkArrangement(haps, ARRANGEMENT) };
  });
  return judgeArrangement(candidates, ARRANGEMENT);
}
