// Reads MIDI clock ticks from an ALSA sequencer port in Node: `aseqdump` (alsa-utils) prints each
// event as a line, and every "Clock" line is timestamped with performance.now() as it arrives. The
// pipe and the event loop add a little jitter of their own, so jitter measured this way is an upper
// bound. startClockReader(port) → { times, stop() }; times grows while it runs.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export function hasAseqdump() {
  return spawnSync('which', ['aseqdump']).status === 0 && spawnSync('which', ['stdbuf']).status === 0;
}

export function startClockReader(port) {
  const times = [];
  const child = spawn('stdbuf', ['-oL', 'aseqdump', '-p', port], { stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (/\bClock\b/.test(line)) times.push(performance.now());
  });
  return {
    times,
    stop: () => {
      lines.close();
      child.kill();
    },
  };
}
