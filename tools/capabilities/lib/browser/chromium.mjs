// Locates and launches the Playwright-managed headless Chromium shell used by the browser tier.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SHELL_DIR_RE = /^chromium_headless_shell-(\d+)$/;

export function findChromium(cacheDir = join(homedir(), '.cache', 'ms-playwright')) {
  if (!existsSync(cacheDir)) return null;
  const candidates = [];
  for (const entry of readdirSync(cacheDir)) {
    const match = SHELL_DIR_RE.exec(entry);
    if (!match) continue;
    const executable = join(cacheDir, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(executable)) candidates.push({ n: Number(match[1]), executable });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.n - a.n);
  return candidates[0].executable;
}

const DEVTOOLS_RE = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]*)/;

export async function launchChromium(executable, userDataDir) {
  const child = spawn(
    executable,
    [
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      child.stderr.off('data', onData);
      reject(new Error('timed out waiting for Chromium DevTools listening line'));
    }, 30000);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = DEVTOOLS_RE.exec(buffer);
      if (match) {
        clearTimeout(timeout);
        child.stderr.off('data', onData);
        resolve(Number(match[2]));
      }
    };
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`chromium exited before DevTools was ready (code ${code})`));
    });
  });

  return {
    port,
    close: () => {
      child.kill();
      // Chromium may still be writing to userDataDir (lock files, shutdown flushes) for a moment
      // after the kill signal; retry the removal instead of letting a transient ENOTEMPTY escape.
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Best-effort cleanup: a leftover temp profile dir is harmless.
      }
    },
  };
}
