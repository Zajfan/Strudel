// EXP-2 (browser, opt): is there a stem export API in the page? renderPatternAudio takes a
// multiChannelOrbits flag, but renders into a 2-channel OfflineAudioContext.
import { pageGlobals } from '../../lib/browser/page-globals.mjs';
import { renderInPage } from '../../lib/browser/page-render.mjs';
import { isStemApiName, judgeStems } from '../../lib/checks.mjs';
import { stemPattern } from '../../lib/patterns.mjs';

export async function probe({ page, thresholds }) {
  const apis = (await pageGlobals(page, /stem/i)).filter(isStemApiName);
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
  // The probe does not know how to drive a found stem-like global, so it is never exercised.
  const { status, error, reason } = judgeStems({ apis, exercised: false, residualDbfs: null, eventCount: out.events }, thresholds);
  return { status, metrics, notes: { ...notes, ...(error && { error }), ...(reason && { reason }) } };
}
