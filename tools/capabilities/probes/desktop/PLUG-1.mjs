// PLUG-1 (desktop): a standalone Rust host (clack-host, the same stack a Tauri backend would use)
// loads the Surge XT CLAP instrument, plays note events derived from a Strudel pattern and
// captures non-silent output.
// Spike sources: tools/capabilities/spikes/clap-host. Without Surge XT installed this is not-run.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { noteToMidi } from '@strudel/core';
import { loadScope } from '../../lib/scope.mjs';
import { PLUGIN_PATTERN, pluginPattern } from '../../lib/patterns.mjs';

const SURGE_CANDIDATES = [
  '/usr/lib/clap/Surge XT.clap',
  '/usr/lib64/clap/Surge XT.clap',
  join(homedir(), '.clap', 'Surge XT.clap'),
];

const SAMPLE_RATE = 48000;

// Onset haps -> note on/off events at exact frames. Pattern time is in cycles; seconds = cycles / cps.
export function patternToNoteEvents(pattern, { cycles, cps, sampleRate }) {
  const events = [];
  for (const hap of pattern.queryArc(0, cycles).filter((h) => h.hasOnset())) {
    const value = hap.value ?? {};
    const key = typeof value.note === 'string' ? noteToMidi(value.note) : Math.round(Number(value.note));
    if (!Number.isInteger(key) || key < 0 || key > 127) {
      throw new Error(`hap has no MIDI-range note: ${JSON.stringify(value)}`);
    }
    const velocity = value.velocity ?? 0.8;
    const on = Math.round((hap.whole.begin.valueOf() / cps) * sampleRate);
    const off = Math.round((hap.whole.end.valueOf() / cps) * sampleRate);
    events.push({ frame: on, key, velocity, type: 'on' }, { frame: off, key, velocity: 0, type: 'off' });
  }
  return events.sort((a, b) => a.frame - b.frame || (a.type === 'off' ? -1 : 1) - (b.type === 'off' ? -1 : 1));
}

export async function probe({ repoRoot, thresholds, tmpDir, log }) {
  const plugin = SURGE_CANDIDATES.find((p) => existsSync(p));
  if (!plugin) {
    return {
      status: 'not-run',
      metrics: {},
      notes: {
        reason: 'Surge XT not installed (see follow-ups doc for the install command)',
        searched: SURGE_CANDIDATES.map((p) => p.replace(homedir(), '~')),
      },
    };
  }

  const manifest = join(repoRoot, 'tools', 'capabilities', 'spikes', 'clap-host', 'Cargo.toml');
  // Build output goes to a persistent directory under the OS temp dir so no target/ lands in the
  // tree and repeat runs reuse the compiled dependencies.
  const targetDir = join(tmpDir, 'strudel-caps-clap-host-target');
  const outJson = join(tmpDir, `strudel-caps-plug1-${process.pid}.json`);
  const eventsJson = join(tmpDir, `strudel-caps-plug1-events-${process.pid}.json`);
  rmSync(outJson, { force: true });

  await loadScope();
  const { source, cycles, cps, tailSeconds } = PLUGIN_PATTERN;
  const events = patternToNoteEvents(pluginPattern(), { cycles, cps, sampleRate: SAMPLE_RATE });
  const frames = Math.round((cycles / cps + tailSeconds) * SAMPLE_RATE);
  writeFileSync(eventsJson, JSON.stringify({ sampleRate: SAMPLE_RATE, frames, events }));
  // --locked: never rewrite the tracked Cargo.lock; the spike builds from its pinned dependencies.
  const args = [
    'run', '--release', '--locked', '--manifest-path', manifest, '--target-dir', targetDir,
    '--', plugin, outJson, eventsJson,
  ];
  log(`cargo ${args.join(' ')}`);
  const start = performance.now();
  const run = spawnSync('cargo', args, {
    encoding: 'utf8',
    timeout: thresholds.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = Math.round((performance.now() - start) / 1000);
  rmSync(eventsJson, { force: true });
  if (run.error?.code === 'ENOENT') {
    return { status: 'not-run', metrics: {}, notes: { reason: 'cargo is not on PATH', plugin } };
  }
  const logTail = (run.stderr ?? '').trim().split('\n').slice(-30).join('\n');
  const metrics = {
    exitCode: run.status,
    seconds,
    plugin: plugin.replace(homedir(), '~'),
    patternEvents: events.length,
  };
  const baseNotes = { pattern: source };
  if (run.error) {
    const headline = run.error.code === 'ETIMEDOUT' ? 'timed out' : `spawn error ${run.error.code ?? 'unknown'}`;
    return { status: 'fail', metrics: { ...metrics, headline }, notes: { ...baseNotes, error: String(run.error), logTail } };
  }
  if (run.status !== 0) {
    return {
      status: 'fail',
      metrics: { ...metrics, headline: 'clap-host build or run failed' },
      notes: { ...baseNotes, logTail },
    };
  }

  let out;
  try {
    out = JSON.parse(readFileSync(outJson, 'utf8'));
  } catch (err) {
    return {
      status: 'fail',
      metrics: { ...metrics, headline: 'clap-host wrote no readable result' },
      notes: { ...baseNotes, error: String(err), logTail },
    };
  } finally {
    rmSync(outJson, { force: true });
  }

  const rendered = {
    ...metrics,
    pluginId: out.pluginId,
    pluginName: out.pluginName,
    frames: out.frames,
    rms: out.rms,
    peak: out.peak,
    eventsDelivered: out.eventsDelivered,
  };
  // Every pattern event must reach the plugin, and there must be at least one.
  if (!(events.length > 0 && out.eventsDelivered === events.length)) {
    return {
      status: 'fail',
      metrics: { ...rendered, headline: `delivered ${out.eventsDelivered} of ${events.length} pattern events` },
      notes: { ...baseNotes, logTail },
    };
  }
  // Fail-closed: a missing threshold, or a missing, non-numeric or too-quiet RMS, is never a pass.
  if (thresholds.minRms == null) {
    return { status: 'fail', metrics: rendered, notes: { ...baseNotes, error: 'threshold minRms missing', logTail } };
  }
  if (!(typeof out.rms === 'number' && out.rms >= thresholds.minRms)) {
    return {
      status: 'fail',
      metrics: { ...rendered, headline: 'silent output' },
      notes: { ...baseNotes, error: `rms ${out.rms} below ${thresholds.minRms}`, logTail },
    };
  }
  // The spec names Surge XT; a different instrument behind that file name is not evidence for it.
  if (!/surge/i.test(`${out.pluginId} ${out.pluginName}`)) {
    return { status: 'fail', metrics: { ...rendered, headline: 'loaded plugin is not Surge XT' }, notes: { ...baseNotes, logTail } };
  }
  return { status: 'pass', metrics: { ...rendered, headline: 'Surge XT via clack-host' }, notes: baseNotes };
}
