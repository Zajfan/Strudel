// SYNC-1 (browser, opt): MIDI clock-out jitter needs a MIDI output device, which headless Chromium lacks.
export async function probe({ page }) {
  const webMidi = await page.evaluate(() => typeof navigator.requestMIDIAccess);
  return {
    status: 'not-run',
    metrics: { requestMIDIAccess: webMidi },
    notes: { reason: 'headless Chromium has no MIDI output devices' },
  };
}
