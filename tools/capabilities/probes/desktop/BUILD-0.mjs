// BUILD-0 (desktop): the Tauri backend type-checks with cargo.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export async function probe({ repoRoot, thresholds, log }) {
  const manifest = join(repoRoot, 'src-tauri', 'Cargo.toml');
  log(`cargo check --manifest-path ${manifest}`);
  const start = performance.now();
  const run = spawnSync('cargo', ['check', '--manifest-path', manifest], {
    encoding: 'utf8',
    timeout: thresholds.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = Math.round((performance.now() - start) / 1000);
  if (run.error?.code === 'ENOENT') {
    return { status: 'not-run', metrics: {}, notes: { reason: 'cargo is not on PATH' } };
  }
  const logTail = (run.stderr ?? '').trim().split('\n').slice(-30).join('\n');
  const metrics = { exitCode: run.status, seconds };
  if (run.error) {
    const headline = run.error.code === 'ETIMEDOUT' ? 'timed out' : `spawn error ${run.error.code ?? 'unknown'}`;
    return { status: 'fail', metrics: { ...metrics, headline }, notes: { error: String(run.error), logTail } };
  }
  if (run.status !== 0) {
    return { status: 'fail', metrics: { ...metrics, headline: 'cargo check failed' }, notes: { logTail } };
  }
  return { status: 'pass', metrics: { ...metrics, headline: `cargo check ${seconds} s` }, notes: {} };
}
