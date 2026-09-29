// PLUG-1 (desktop): a standalone Rust host (clack-host, the same stack a Tauri backend would use)
// loads the Surge XT CLAP instrument, plays one note and captures non-silent output.
// Spike sources: tools/capabilities/spikes/clap-host. Without Surge XT installed this is not-run.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SURGE_CANDIDATES = [
  '/usr/lib/clap/Surge XT.clap',
  '/usr/lib64/clap/Surge XT.clap',
  join(homedir(), '.clap', 'Surge XT.clap'),
];

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
  rmSync(outJson, { force: true });
  // --locked: never rewrite the tracked Cargo.lock; the spike builds from its pinned dependencies.
  const args = [
    'run', '--release', '--locked', '--manifest-path', manifest, '--target-dir', targetDir,
    '--', plugin, outJson,
  ];
  log(`cargo ${args.join(' ')}`);
  const start = performance.now();
  const run = spawnSync('cargo', args, {
    encoding: 'utf8',
    timeout: thresholds.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = Math.round((performance.now() - start) / 1000);
  if (run.error?.code === 'ENOENT') {
    return { status: 'not-run', metrics: {}, notes: { reason: 'cargo is not on PATH', plugin } };
  }
  const logTail = (run.stderr ?? '').trim().split('\n').slice(-30).join('\n');
  const metrics = { exitCode: run.status, seconds, plugin: plugin.replace(homedir(), '~') };
  if (run.error) {
    const headline = run.error.code === 'ETIMEDOUT' ? 'timed out' : `spawn error ${run.error.code ?? 'unknown'}`;
    return { status: 'fail', metrics: { ...metrics, headline }, notes: { error: String(run.error), logTail } };
  }
  if (run.status !== 0) {
    return {
      status: 'fail',
      metrics: { ...metrics, headline: 'clap-host build or run failed' },
      notes: { logTail },
    };
  }

  let out;
  try {
    out = JSON.parse(readFileSync(outJson, 'utf8'));
  } catch (err) {
    return {
      status: 'fail',
      metrics: { ...metrics, headline: 'clap-host wrote no readable result' },
      notes: { error: String(err), logTail },
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
  };
  // Fail-closed: a missing, non-numeric or zero RMS is silence, never a pass.
  if (!(typeof out.rms === 'number' && out.rms > 0)) {
    return { status: 'fail', metrics: { ...rendered, headline: 'silent output' }, notes: { logTail } };
  }
  // The spec names Surge XT; a different instrument behind that file name is not evidence for it.
  if (!/surge/i.test(`${out.pluginId} ${out.pluginName}`)) {
    return { status: 'fail', metrics: { ...rendered, headline: 'loaded plugin is not Surge XT' }, notes: { logTail } };
  }
  return { status: 'pass', metrics: { ...rendered, headline: 'Surge XT via clack-host' }, notes: {} };
}
