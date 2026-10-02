// EXP-2 (browser, opt): the page's renderPatternStems renders one stereo stem per orbit in a single
// multi-channel render. The stems must be non-silent, one per orbit of the pattern, and sum to a
// separate ordinary stereo render of the same pattern (renderPatternAudio) within maxResidualDbfs.
import { decodeFloat32 } from '../../lib/measure.mjs';
import { rms } from '../../lib/audio.mjs';
import { pageGlobals } from '../../lib/browser/page-globals.mjs';
import { renderInPage } from '../../lib/browser/page-render.mjs';
import { withMiniStrings } from '../../lib/browser/page-scope.mjs';
import { isStemApiName, judgeStems, stemResidual } from '../../lib/checks.mjs';
import { stemPattern } from '../../lib/patterns.mjs';

const OPTS = { cps: 1, cycles: 2, sampleRate: 48000 };
const ORBITS = [1, 2, 3, 4];

// Runs in the page; serialized with toString(), so no closures over Node scope.
async function stemsInPageScript({ builderSource, cps, cycles, sampleRate }) {
  if (typeof globalThis.renderPatternStems !== 'function') return { missing: 'renderPatternStems' };
  const pattern = (0, eval)(`(${builderSource})`)();
  const { mix, stems } = await globalThis.renderPatternStems(pattern, cps, 0, cycles, sampleRate, 128);
  const b64 = (samples) => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  return {
    mixLength: mix.length,
    stems: [...stems].map(([orbit, buffer]) => ({ orbit, channels: buffer.numberOfChannels, left: b64(buffer.getChannelData(0)) })),
  };
}

export async function probe({ page, thresholds }) {
  const apis = (await pageGlobals(page, /stem/i)).filter(isStemApiName);
  const reference = await renderInPage(page, stemPattern, OPTS);
  const out = await withMiniStrings(page, () =>
    page.evaluate(stemsInPageScript, { builderSource: stemPattern.toString(), ...OPTS }),
  );
  const notes = { reference: 'renderPatternAudio stereo render of the same pattern', scope: 'left channels compared' };
  if (out?.missing) {
    const { status, error, reason } = judgeStems({ apis, exercised: false, residualDbfs: null, eventCount: reference.events }, thresholds);
    return { status, metrics: { stemApis: apis, headline: 'no stem API' }, notes: { ...notes, ...(error && { error }), ...(reason && { reason }) } };
  }
  const stems = out.stems.map((s) => ({ ...s, left: decodeFloat32(s.left) }));
  const { residualDbfs } = stemResidual(reference.left, stems.map((s) => s.left));
  const stemRms = Object.fromEntries(stems.map((s) => [s.orbit, rms(s.left)]));
  const metrics = {
    stemApis: apis,
    orbits: stems.map((s) => s.orbit),
    stemRms,
    residualDbfs,
    lengthSamples: out.mixLength,
    referenceLength: reference.length,
    headline: `${stems.length} stems, residual ${residualDbfs.toFixed(1)} dBFS`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (String(metrics.orbits) !== String(ORBITS)) return fail(`stems for orbits ${metrics.orbits}, expected ${ORBITS}`);
  if (stems.some((s) => s.channels !== 2)) return fail('a stem is not stereo');
  if (out.mixLength !== reference.length) return fail(`stem length ${out.mixLength} != mix length ${reference.length}`);
  const silent = stems.filter((s) => !(stemRms[s.orbit] > 1e-4)).map((s) => s.orbit);
  if (silent.length) return fail(`silent stems: orbits ${silent}`);
  const { status, error, reason } = judgeStems({ apis, exercised: true, residualDbfs, eventCount: reference.events }, thresholds);
  return { status, metrics, notes: { ...notes, ...(error && { error }), ...(reason && { reason }) } };
}
