/* global note */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadScope } from '../lib/scope.mjs';
import { PLUGIN_PATTERN, pluginPattern } from '../lib/patterns.mjs';
import { patternToNoteEvents } from '../probes/desktop/PLUG-1.mjs';

describe('PLUG-1 pattern events', () => {
  beforeAll(() => loadScope());

  it('turns note("c4 e4 g4 c5") into sample-exact on/off pairs', () => {
    const { cycles, cps } = PLUGIN_PATTERN;
    const events = patternToNoteEvents(pluginPattern(), { cycles, cps, sampleRate: 48000 });
    expect(events).toEqual([
      { frame: 0, key: 60, velocity: 0.8, type: 'on' },
      { frame: 12000, key: 60, velocity: 0, type: 'off' },
      { frame: 12000, key: 64, velocity: 0.8, type: 'on' },
      { frame: 24000, key: 64, velocity: 0, type: 'off' },
      { frame: 24000, key: 67, velocity: 0.8, type: 'on' },
      { frame: 36000, key: 67, velocity: 0, type: 'off' },
      { frame: 36000, key: 72, velocity: 0.8, type: 'on' },
      { frame: 48000, key: 72, velocity: 0, type: 'off' },
    ]);
  });

  it('keeps the recorded source in step with the pattern', () => {
    const fromSource = new Function(`return ${PLUGIN_PATTERN.source}`)();
    const a = patternToNoteEvents(fromSource, { cycles: 1, cps: 1, sampleRate: 48000 });
    const b = patternToNoteEvents(pluginPattern(), { cycles: 1, cps: 1, sampleRate: 48000 });
    expect(a).toEqual(b);
  });

  it('honours hap velocity and scales time by cps', () => {
    const events = patternToNoteEvents(note('a4').velocity(0.5), { cycles: 1, cps: 2, sampleRate: 48000 });
    expect(events).toEqual([
      { frame: 0, key: 69, velocity: 0.5, type: 'on' },
      { frame: 24000, key: 69, velocity: 0, type: 'off' },
    ]);
  });
});
