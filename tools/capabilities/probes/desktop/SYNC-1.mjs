// SYNC-1 (desktop): MIDI clock out of the desktop app, as a user sends it
// (`midicmd("clock*48").midi(port)`). WebKitGTK has no Web MIDI, so the desktop app sends MIDI from
// Rust (src-tauri/src/midibridge.rs); here to ALSA's "Midi Through" loopback, read back in Node with
// aseqdump (lib/midi-reader.mjs). Jitter is the largest deviation of a tick from a straight line
// through all tick times (clockJitter) over RECORD_SECONDS; the reader's own jitter is included.
import { clockJitter } from '../../lib/checks.mjs';
import { hasAseqdump, startClockReader } from '../../lib/midi-reader.mjs';

export const usesPage = true;

const PORT = 'Midi Through Port-0';
const ALSA_PORT = '14:0';
const CPS = 0.5;
const CLOCKS_PER_CYCLE = 48;
const RECORD_SECONDS = 60;
const SETTLE_SECONDS = 1;
// the app's MIDI bridge opens its ports a few seconds after start
const BRIDGE_START_SECONDS = 5;

export async function probe({ page, thresholds }) {
  const notes = {
    route: `midicmd("clock*${CLOCKS_PER_CYCLE}").midi('${PORT}') at ${CPS} cps -> Rust midibridge -> ALSA ${ALSA_PORT} -> aseqdump`,
  };
  if (thresholds.maxJitterMs == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold maxJitterMs missing' } };
  if (!hasAseqdump()) return { status: 'not-run', metrics: {}, notes: { ...notes, reason: 'aseqdump/stdbuf not installed (alsa-utils, coreutils)' } };
  const reader = startClockReader(ALSA_PORT);
  // when playback was asked to start, on the reader's clock
  const startsAt = performance.now() + BRIDGE_START_SECONDS * 1000;
  let out;
  try {
    out = await page.evaluate(
      async ({ code, wait, seconds }) => {
        await new Promise((r) => setTimeout(r, wait * 1000));
        const m = window.strudelMirror;
        try {
          m.setCode(code);
          await m.evaluate();
          const error = String(m.repl.state.error || '');
          if (error) return { error };
          await new Promise((r) => setTimeout(r, seconds * 1000));
          return {};
        } finally {
          m.stop();
        }
      },
      { code: `setcps(${CPS})\nmidicmd("clock*${CLOCKS_PER_CYCLE}").midi('${PORT}')`, wait: BRIDGE_START_SECONDS, seconds: RECORD_SECONDS },
      { timeoutMs: (RECORD_SECONDS + BRIDGE_START_SECONDS + 60) * 1000 },
    );
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    reader.stop();
  }
  if (out?.error) return { status: 'fail', metrics: {}, notes: { ...notes, error: out.error } };
  const times = reader.times;
  const settled = times.filter((t) => t - times[0] >= SETTLE_SECONDS * 1000);
  const r = clockJitter(settled);
  const expectedIntervalMs = 1000 / (CPS * CLOCKS_PER_CYCLE);
  // ticks expected over the span the clock ran (its late start is reported as startDelaySeconds)
  const expectedTicks = settled.length ? ((settled.at(-1) - settled[0]) / 1000) * CPS * CLOCKS_PER_CYCLE + 1 : Infinity;
  const intervals = settled.slice(1).map((t, i) => t - settled[i]);
  const metrics = {
    ticks: times.length,
    spanSeconds: times.length ? (times.at(-1) - times[0]) / 1000 : 0,
    // from asking to play to the first tick: start-up of the app's audio clock and MIDI bridge
    startDelaySeconds: times.length ? (times[0] - startsAt) / 1000 : NaN,
    longestGapMs: intervals.length ? Math.max(...intervals) : NaN,
    measuredTicks: r.count,
    expectedIntervalMs,
    intervalMs: r.intervalMs,
    maxJitterMs: r.maxJitterMs,
    rmsJitterMs: r.rmsJitterMs,
    headline: `${r.maxJitterMs.toFixed(3)} ms max jitter over ${r.count} ticks`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (!(r.count >= 0.99 * expectedTicks)) return fail(`only ${r.count} clock ticks received, expected about ${Math.round(expectedTicks)}`);
  if (!(metrics.longestGapMs <= 1.5 * expectedIntervalMs)) return fail(`a gap of ${metrics.longestGapMs.toFixed(1)} ms between ticks`);
  if (!(metrics.spanSeconds >= RECORD_SECONDS / 2)) return fail(`the clock ran only ${metrics.spanSeconds.toFixed(1)} s of ${RECORD_SECONDS} s`);
  if (!(Math.abs(r.intervalMs / expectedIntervalMs - 1) < 0.01)) return fail(`clock interval ${r.intervalMs.toFixed(3)} ms, expected ${expectedIntervalMs.toFixed(3)} ms`);
  if (!(r.maxJitterMs <= thresholds.maxJitterMs)) return fail(`max jitter ${r.maxJitterMs.toFixed(3)} ms > ${thresholds.maxJitterMs} ms`);
  return { status: 'pass', metrics, notes };
}
