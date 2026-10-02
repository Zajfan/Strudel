// ARR-1 (browser): an 8-section, 64-bar arrangement queried in the page, with correct boundaries
// and a hard ending. Every candidate construct (bare arrange(), and arrange() cut off at bar 64)
// is checked; the cell passes if any one of them gives the right sections and nothing after the end.
// When the passing construct is the dedicated arrange().once(), a short song is also played in the
// REPL: the transport must stop by itself at the end.
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
  const verdict = judgeArrangement(candidates, ARRANGEMENT);
  if (verdict.status !== 'pass' || verdict.notes.construct !== 'arrange().once()') {
    return verdict;
  }
  const transport = await playShortSong(page);
  verdict.metrics.transport = transport;
  if (!transport.startedAfterEval || transport.startedAfterEnd) {
    return {
      status: 'fail',
      metrics: verdict.metrics,
      notes: { ...verdict.notes, error: `arrange().once() did not stop the transport: ${JSON.stringify(transport)}` },
    };
  }
  return verdict;
}

// 2 cycles at 2 cps: the song ends 1 s after it starts; checked after 2.5 s
async function playShortSong(page) {
  return page.evaluate(async () => {
    const m = window.strudelMirror;
    try {
      m.setCode('setcps(2)\narrange([1, note("c4")], [1, note("e4")]).s("sine").gain(0.05).once()');
      await m.evaluate();
      const startedAfterEval = m.repl.state.started;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return { startedAfterEval, startedAfterEnd: m.repl.state.started, error: String(m.repl.state.error || '') };
    } finally {
      m.stop();
    }
  });
}
