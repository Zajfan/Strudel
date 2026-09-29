// CUE-1 (browser, opt): can one pattern be routed to a second output device (a headphone cue)?
import { pageGlobals } from '../../lib/browser/page-globals.mjs';

export async function probe({ page }) {
  const scan = {
    setSinkId: await page.evaluate(() => typeof AudioContext.prototype.setSinkId),
    globals: await pageGlobals(page, /cue|sink/i),
  };
  const metrics = { setSinkId: scan.setSinkId, cueGlobals: scan.globals };
  if (scan.setSinkId !== 'function') {
    return {
      status: 'wall',
      metrics: { ...metrics, headline: 'no setSinkId' },
      notes: { evidence: 'AudioContext.setSinkId unavailable in this browser', platform: { setSinkId: scan.setSinkId } },
    };
  }
  if (scan.globals.some((k) => /cue/i.test(k))) {
    return {
      status: 'not-run',
      metrics: { ...metrics, headline: 'cue globals found' },
      notes: { reason: `cue-like globals found but not exercised: ${scan.globals.join(', ')}`, platform: { setSinkId: scan.setSinkId } },
    };
  }
  return {
    status: 'fail',
    metrics: { ...metrics, headline: 'no per-pattern cue' },
    notes: { error: 'no per-pattern cue output; one output device for all patterns', platform: { setSinkId: scan.setSinkId } },
  };
}
