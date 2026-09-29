// CLI tier builds: core, mini notation and supradough load in plain Node and make sound.
import { rms } from '../../lib/audio.mjs';
import { renderPattern } from '../../lib/render.mjs';

export async function probe() {
  const { note } = await import('@strudel/core');
  const { mini } = await import('@strudel/mini');
  const out = renderPattern(note(mini('c4 e4 g4')).s('sine'), { cps: 1, cycles: 1, tail: 0.25, sampleRate: 48000 });
  const level = rms(out.left);
  const metrics = { node: process.version, events: out.eventCount, rms: level, headline: `node ${process.version}` };
  if (out.eventCount === 0) return { status: 'fail', metrics, notes: { error: 'no events rendered' } };
  if (level === 0) return { status: 'fail', metrics, notes: { error: 'render was silent' } };
  return { status: 'pass', metrics, notes: {} };
}
