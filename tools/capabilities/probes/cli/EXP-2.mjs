// EXP-2 (CLI): supradough's renderDoughStems renders one stereo stem per orbit in a single pass. The
// stems must be non-silent, one per orbit of the pattern, and sum to a separate ordinary render of
// the same pattern (renderDough) within maxResidualDbfs.
import { rms } from '../../lib/audio.mjs';
import { isStemApiName, judgeStems, stemResidual } from '../../lib/checks.mjs';
import { stemPattern } from '../../lib/patterns.mjs';
import { loadScope } from '../../lib/scope.mjs';
import * as supradoughRender from '../../../../packages/supradough/render.mjs';

const ORBITS = [1, 2, 3, 4];
const OPTS = { cps: 1, cycles: 2, tail: 0.5 };

export async function probe({ thresholds }) {
  await loadScope();
  const apis = Object.keys(supradoughRender)
    .filter(isStemApiName)
    .map((k) => `supradough.${k}`);
  const reference = supradoughRender.renderDough(stemPattern(), OPTS);
  const { stems, eventCount } = supradoughRender.renderDoughStems(stemPattern(), OPTS);
  const lefts = [...stems.values()].map((s) => s.left);
  const { residualDbfs } = stemResidual(reference.left, lefts);
  const stemRms = Object.fromEntries([...stems].map(([orbit, s]) => [orbit, rms(s.left)]));
  const orbits = [...stems.keys()];
  const metrics = {
    stemApis: apis,
    orbits,
    stemRms,
    residualDbfs,
    headline: `${stems.size} stems, residual ${residualDbfs.toFixed(1)} dBFS`,
  };
  const notes = { reference: 'renderDough render of the same pattern', scope: 'left channels compared' };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (String(orbits) !== String(ORBITS)) return fail(`stems for orbits ${orbits}, expected ${ORBITS}`);
  const silent = orbits.filter((o) => !(stemRms[o] > 1e-4));
  if (silent.length) return fail(`silent stems: orbits ${silent}`);
  const { status, error, reason } = judgeStems({ apis, exercised: true, residualDbfs, eventCount: Math.min(eventCount, reference.eventCount) }, thresholds);
  return { status, metrics, notes: { ...notes, ...(error && { error }), ...(reason && { reason }) } };
}
