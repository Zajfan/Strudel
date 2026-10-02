// SYNC-1 (CLI, opt): MIDI clock out of the CLI player (`strudel play`, packages/cli), as a user writes
// it (`midicmd("clock*48").midi(port)`), to ALSA's "Midi Through" loopback, read back with aseqdump
// (lib/midi-reader.mjs). Jitter is the largest deviation of a tick from a straight line through all
// tick times (clockJitter) over RECORD_SECONDS; the reader's own jitter is included.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clockJitter } from '../../lib/checks.mjs';
import { hasAseqdump, startClockReader } from '../../lib/midi-reader.mjs';

const PORT = 'Midi Through Port-0';
const ALSA_PORT = '14:0';
const CPS = 0.5;
const CLOCKS_PER_CYCLE = 48;
const RECORD_SECONDS = 60;
const SETTLE_SECONDS = 1;

export async function probe({ thresholds, repoRoot, tmpDir }) {
  const code = `setcps(${CPS})\nmidicmd("clock*${CLOCKS_PER_CYCLE}").midi('${PORT}')\n`;
  const notes = { route: `strudel play: ${code.replace(/\n/g, '; ')} -> ALSA ${ALSA_PORT} -> aseqdump` };
  if (thresholds.maxJitterMs == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold maxJitterMs missing' } };
  if (!hasAseqdump()) return { status: 'not-run', metrics: {}, notes: { ...notes, reason: 'aseqdump/stdbuf not installed (alsa-utils, coreutils)' } };

  const dir = mkdtempSync(join(tmpDir, 'strudel-sync1-'));
  const file = join(dir, 'clock.strudel');
  writeFileSync(file, code);
  const reader = startClockReader(ALSA_PORT);
  const output = [];
  const player = spawn(process.execPath, [join(repoRoot, 'packages', 'cli', 'bin', 'strudel.mjs'), 'play', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  player.stdout.on('data', (d) => output.push(String(d)));
  player.stderr.on('data', (d) => output.push(String(d)));
  try {
    await new Promise((resolve) => setTimeout(resolve, RECORD_SECONDS * 1000));
  } finally {
    player.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    reader.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  const log = output.join('').split('\n').filter((l) => l.startsWith('[')).slice(-5);
  const times = reader.times;
  const settled = times.filter((t) => t - times[0] >= SETTLE_SECONDS * 1000);
  const r = clockJitter(settled);
  const intervals = settled.slice(1).map((t, i) => t - settled[i]);
  const expectedIntervalMs = 1000 / (CPS * CLOCKS_PER_CYCLE);
  const metrics = {
    ticks: times.length,
    spanSeconds: times.length ? (times.at(-1) - times[0]) / 1000 : 0,
    longestGapMs: intervals.length ? Math.max(...intervals) : NaN,
    measuredTicks: r.count,
    expectedIntervalMs,
    intervalMs: r.intervalMs,
    maxJitterMs: r.maxJitterMs,
    rmsJitterMs: r.rmsJitterMs,
    headline: `${r.maxJitterMs.toFixed(3)} ms max jitter over ${r.count} ticks`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, log, error } });
  const expectedTicks = settled.length ? ((settled.at(-1) - settled[0]) / 1000) * CPS * CLOCKS_PER_CYCLE + 1 : Infinity;
  if (!(metrics.spanSeconds >= RECORD_SECONDS / 2)) return fail(`the clock ran only ${metrics.spanSeconds.toFixed(1)} s of ${RECORD_SECONDS} s`);
  if (!(r.count >= 0.99 * expectedTicks)) return fail(`only ${r.count} clock ticks received, expected about ${Math.round(expectedTicks)}`);
  if (!(metrics.longestGapMs <= 1.5 * expectedIntervalMs)) return fail(`a gap of ${metrics.longestGapMs.toFixed(1)} ms between ticks`);
  if (!(Math.abs(r.intervalMs / expectedIntervalMs - 1) < 0.01)) return fail(`clock interval ${r.intervalMs.toFixed(3)} ms, expected ${expectedIntervalMs.toFixed(3)} ms`);
  if (!(r.maxJitterMs <= thresholds.maxJitterMs)) return fail(`max jitter ${r.maxJitterMs.toFixed(3)} ms > ${thresholds.maxJitterMs} ms`);
  return { status: 'pass', metrics, notes };
}
