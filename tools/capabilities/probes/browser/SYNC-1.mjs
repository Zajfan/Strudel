// SYNC-1 (browser, opt): MIDI clock out, as a user sends it (`midicmd("clock*48").midi(port)`), to
// ALSA's "Midi Through" loopback port, read back on the same port's input. Jitter is the largest
// deviation of a received clock tick from a straight line through all tick times (clockJitter), over
// RECORD_SECONDS of playback. The receive timestamps include the loopback, so this is an upper bound
// on the output's own jitter.
import { clockJitter } from '../../lib/checks.mjs';

const PORT = 'Midi Through Port-0';
const CPS = 0.5;
const CLOCKS_PER_CYCLE = 48;
const RECORD_SECONDS = 60;
const SETTLE_SECONDS = 1; // ticks in the first second are left out (start-up)

// Runs in the page; serialized with toString(), so no closures over Node scope.
async function clockInPage({ port, code, seconds }) {
  const access = await navigator.requestMIDIAccess({ sysex: false });
  const input = [...access.inputs.values()].find((i) => i.name === port);
  if (!input) return { error: `no MIDI input named ${port}`, inputs: [...access.inputs.values()].map((i) => i.name) };
  const times = [];
  input.onmidimessage = (e) => {
    if (e.data[0] === 0xf8) times.push(e.timeStamp);
  };
  const m = window.strudelMirror;
  try {
    m.setCode(code);
    await m.evaluate();
    const error = String(m.repl.state.error || '');
    if (error) return { error };
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  } finally {
    m.stop();
    input.onmidimessage = null;
  }
  return { times };
}

export async function probe({ page, thresholds }) {
  const notes = {
    route: `midicmd("clock*${CLOCKS_PER_CYCLE}").midi('${PORT}') at ${CPS} cps; read back on the loopback input`,
    scope: 'headless Chromium, ALSA Midi Through loopback; receive timestamps (event.timeStamp) include the loopback',
  };
  if (thresholds.maxJitterMs == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold maxJitterMs missing' } };
  try {
    // current Chromium gates all Web MIDI behind both permissions
    await page.send('Browser.grantPermissions', { permissions: ['midi', 'midiSysex'] });
  } catch (err) {
    return { status: 'not-run', metrics: {}, notes: { ...notes, reason: `could not grant MIDI permission: ${err.message}` } };
  }
  const outputs = await page.evaluate(async () => {
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      return [...access.outputs.values()].map((o) => o.name);
    } catch (err) {
      return { error: String(err) };
    }
  });
  if (!Array.isArray(outputs)) return { status: 'not-run', metrics: {}, notes: { ...notes, reason: `no Web MIDI: ${outputs.error}` } };
  if (!outputs.includes(PORT)) return { status: 'not-run', metrics: { outputs }, notes: { ...notes, reason: `no "${PORT}" MIDI port (load snd-seq-dummy)` } };

  // the port name in single quotes: .midi() takes a plain string, not mini-notation
  const code = `setcps(${CPS})\nmidicmd("clock*${CLOCKS_PER_CYCLE}").midi('${PORT}')`;
  const out = await page.evaluate(clockInPage, { port: PORT, code, seconds: RECORD_SECONDS }, { timeoutMs: (RECORD_SECONDS + 60) * 1000 });
  if (out.error) return { status: 'fail', metrics: { outputs }, notes: { ...notes, error: out.error } };
  const settled = out.times.filter((t) => t - out.times[0] >= SETTLE_SECONDS * 1000);
  const r = clockJitter(settled);
  const expectedIntervalMs = 1000 / (CPS * CLOCKS_PER_CYCLE);
  const expectedTicks = (RECORD_SECONDS - SETTLE_SECONDS) * CPS * CLOCKS_PER_CYCLE;
  const metrics = {
    ticks: out.times.length,
    measuredTicks: r.count,
    expectedIntervalMs,
    intervalMs: r.intervalMs,
    maxJitterMs: r.maxJitterMs,
    rmsJitterMs: r.rmsJitterMs,
    headline: `${r.maxJitterMs.toFixed(3)} ms max jitter over ${r.count} ticks`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (!(r.count >= 0.95 * expectedTicks)) return fail(`only ${r.count} clock ticks received, expected about ${expectedTicks}`);
  if (!(Math.abs(r.intervalMs / expectedIntervalMs - 1) < 0.01)) return fail(`clock interval ${r.intervalMs.toFixed(3)} ms, expected ${expectedIntervalMs.toFixed(3)} ms`);
  if (!(r.maxJitterMs <= thresholds.maxJitterMs)) return fail(`max jitter ${r.maxJitterMs.toFixed(3)} ms > ${thresholds.maxJitterMs} ms`);
  return { status: 'pass', metrics, notes };
}
