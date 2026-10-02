// EXP-2 (browser, opt): the page's renderPatternStems renders one stereo stem per orbit in a single
// multi-channel render. The stems must be non-silent, one per orbit of the pattern, and sum to a
// separate ordinary stereo render of the same pattern (renderPatternAudio) within maxResidualDbfs.
import { rms } from '../../lib/audio.mjs';
import { pageGlobals } from '../../lib/browser/page-globals.mjs';
import { renderInPage, renderStemsInPage } from '../../lib/browser/page-render.mjs';
import { isStemApiName, judgeStems, stemResidual } from '../../lib/checks.mjs';
import { stemPattern } from '../../lib/patterns.mjs';

const OPTS = { cps: 1, cycles: 2, sampleRate: 48000 };
const ORBITS = [1, 2, 3, 4];

export async function probe({ page, thresholds }) {
  const apis = (await pageGlobals(page, /stem/i)).filter(isStemApiName);
  const reference = await renderInPage(page, stemPattern, OPTS);
  const out = await renderStemsInPage(page, stemPattern, OPTS);
  const notes = { reference: 'renderPatternAudio stereo render of the same pattern', scope: 'left channels compared' };
  if (!out) {
    const { status, error, reason } = judgeStems({ apis, exercised: false, residualDbfs: null, eventCount: reference.events }, thresholds);
    return { status, metrics: { stemApis: apis, headline: 'no stem API' }, notes: { ...notes, ...(error && { error }), ...(reason && { reason }) } };
  }
  const orbits = [...out.stems.keys()];
  const { residualDbfs } = stemResidual(reference.left, [...out.stems.values()]);
  const stemRms = Object.fromEntries([...out.stems].map(([orbit, left]) => [orbit, rms(left)]));
  const metrics = {
    stemApis: apis,
    orbits,
    stemRms,
    residualDbfs,
    lengthSamples: out.mix.length,
    referenceLength: reference.length,
    headline: `${orbits.length} stems, residual ${residualDbfs.toFixed(1)} dBFS`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (String(orbits) !== String(ORBITS)) return fail(`stems for orbits ${orbits}, expected ${ORBITS}`);
  if ([...out.channels.values()].some((c) => c !== 2)) return fail('a stem is not stereo');
  if (out.mix.length !== reference.length) return fail(`stem length ${out.mix.length} != mix length ${reference.length}`);
  const silent = orbits.filter((o) => !(stemRms[o] > 1e-4));
  if (silent.length) return fail(`silent stems: orbits ${silent}`);
  const { status, error, reason } = judgeStems({ apis, exercised: true, residualDbfs, eventCount: reference.events }, thresholds);
  return { status, metrics, notes: { ...notes, ...(error && { error }), ...(reason && { reason }) } };
}
