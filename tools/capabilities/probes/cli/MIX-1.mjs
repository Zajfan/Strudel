// MIX-1 (CLI): four buses (orbits), one send and one ducked bus, rendered as stems in one pass
// (supradough renderDoughStems): see judgeMix and mixPattern for what is checked.
import { judgeMix } from '../../lib/checks.mjs';
import { MIX, mixPattern } from '../../lib/patterns.mjs';
import { loadScope } from '../../lib/scope.mjs';
import { renderDoughStems } from '../../../../packages/supradough/render.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const { mix, stems, sampleRate, eventCount } = renderDoughStems(mixPattern(), { cps: MIX.cps, cycles: MIX.cycles, tail: 0 });
  const lefts = new Map([...stems].map(([orbit, s]) => [orbit, s.left]));
  const { status, metrics, problems } = judgeMix({ stems: lefts, mix: mix.left, sampleRate }, MIX, thresholds);
  const notes = { engine: 'supradough', buses: 'orbits', send: 'delay on orbit 3', sidechain: 'duckorbit from orbit 2 to orbit 1' };
  const headline = `${metrics.orbits.length} buses, send return ${metrics.sendReturnRms.toFixed(3)} rms, ${metrics.duckDb.toFixed(1)} dB duck`;
  return { status, metrics: { events: eventCount, ...metrics, headline }, notes: problems.length ? { ...notes, error: problems.join('; ') } : notes };
}
