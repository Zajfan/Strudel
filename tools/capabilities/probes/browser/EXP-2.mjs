// EXP-2 (browser, opt): is there a stem export API in the page? renderPatternAudio takes a
// multiChannelOrbits flag, but renders into a 2-channel OfflineAudioContext.
import { pageGlobals } from '../../lib/browser/page-globals.mjs';
import { renderInPage } from '../../lib/browser/page-render.mjs';
import { stemPattern } from '../../lib/patterns.mjs';

export async function probe({ page, thresholds }) {
  const apis = await pageGlobals(page, /stem/i);
  const arity = await page.evaluate(() => (typeof window.renderPatternAudio === 'function' ? window.renderPatternAudio.length : null));
  const out = await renderInPage(page, stemPattern, { cps: 1, cycles: 1, samples: false });
  const metrics = {
    stemApis: apis,
    renderChannels: out.channels,
    renderPatternAudioArity: arity,
    headline: apis.length ? `${apis.length} stem API(s)` : 'no stem API',
  };
  const notes = {
    renderPatternAudio:
      'has a multiChannelOrbits parameter, but renders into new OfflineAudioContext(2, ...) and downloads one stereo WAV',
  };
  if (out.events === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no events rendered' } };
  if (thresholds.maxResidualDbfs == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold maxResidualDbfs missing' } };
  if (!apis.length) return { status: 'fail', metrics, notes: { ...notes, error: 'no stem export API' } };
  // A stem-like global exists, but this probe does not know how to drive it, so it cannot pass.
  return { status: 'not-run', metrics, notes: { ...notes, reason: `stem-like globals found but not exercised: ${apis.join(', ')}` } };
}
