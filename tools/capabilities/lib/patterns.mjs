// Test patterns built from Strudel globals only, so each builder can also run
// in the browser page via fn.toString(). Call loadScope() first in Node.
/* global arrange, gain, note, s, sequence, pure, saw, silence, stack */

export const ARRANGEMENT = { sections: 8, bars: 8 };

export function arrangementPattern() {
  return arrange(...Array.from({ length: 8 }, (_, i) => [8, note(60 + i)]));
}

// ARR-1: the ways a user can write the 64-bar song with a hard ending. Bare arrange() loops;
// .once() is the dedicated ending; the other two are workarounds that cut it off at bar 64. Self-contained (globals only, no references to other
// module functions) so it also runs in the page via toString().
export function arrangementCandidates() {
  const sections = Array.from({ length: 8 }, (_, i) => [8, note(60 + i)]);
  const bare = () => arrange(...sections);
  return [
    { name: 'arrange()', pattern: bare() },
    { name: 'arrange().once()', pattern: bare().once() },
    { name: 'arrange() + filterWhen(t < 64)', pattern: bare().filterWhen((t) => t < 64) },
    { name: 'arrange() + silence tail', pattern: arrange(...sections, [1e6, silence]) },
  ];
}

export function tuningCases() {
  const ji = [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 16 / 9, 15 / 8];
  const steps = (n) => Array.from({ length: n }, (_, k) => k);
  return [
    {
      name: '19-EDO',
      pattern: sequence(...steps(19)).fmap((k) => ({ i: k })).xen('19edo'),
      expected: steps(19).map((k) => 220 * Math.pow(2, k / 19)),
    },
    {
      name: '12-tone just intonation',
      pattern: sequence(...steps(12)).fmap((k) => ({ i: k })).xen('12ji'),
      expected: ji.map((r) => 220 * r),
    },
  ];
}

export const TUNING_RENDER_EXPECTED = 220 * Math.pow(2, 7 / 19);

export function tuningRenderPattern() {
  return pure({ i: 7 }).xen('19edo').s('sine').gain(0.5);
}

export const ERROR_CASES = [
  { name: 'syntax', code: 'note("c e g")\n  .s("sine")\n  .lpf(800 +)\n', line: 3, column: 12 },
  { name: 'unknown function', code: 'note("c e g")\n  .s("sine")\n  .notAFunction(2)\n', line: 3, column: 3 },
];

export const AUTOMATION = { steps: 16, cps: 1 };

export function automationPattern() {
  return note(69).s('sine').fast(16).clip(0.5).attack(0).release(0.002).gain(saw.range(0.2, 1));
}

// AUT-1 ramp: one held note of a 1 kHz sine (exactly 48 samples per period at 48 kHz), its gain
// automated from 0.1 to 1 over the note with `auto`. calibrationPattern() plays the same tone at
// constant gains 0.10, 0.11, ... 1.00, one per step, so a probe can map measured amplitude back to
// gain without knowing the engine's gain law.
export const RAMP = { cps: 1, from: 0.1, to: 1, freq: 1000, calibrationSteps: 91, calibrationCycles: 6 };

export function rampPattern() {
  return s('sine').freq(1000).attack(0).release(0.01).clip(1).gain(1).auto(saw.range(0.1, 1));
}

export function calibrationPattern() {
  const gains = Array.from({ length: 91 }, (_, k) => Math.round(10 + k) / 100);
  // the gains first, so they give the structure: one note per gain
  return gain(sequence(...gains)).s('sine').freq(1000).attack(0).release(0.002).clip(1).slow(6);
}

export const DUCK = { cps: 1, triggerAt: 0.25 };

export function duckPattern() {
  return stack(
    note(48).s('sine').orbit(1).gain(0.5).attack(0).release(0.01).clip(1),
    note(72).s('sine').orbit(2).gain(0).struct('~ x ~ ~').duckorbit(1).duckdepth(1).duckattack(0.1),
  );
}

// MIX-1: four buses (orbits). Orbit 1 holds a note and is ducked by a silent sidechain trigger on
// orbit 2 at duckAt; orbit 3 plays a short note at 0.5 with a delay send, whose echoes must come
// back on orbit 3 after the note has ended (sendWindow); orbit 4 plays a plain note at 0.5 that has
// ended by sendWindow. Orbits 3 and 4 start after the duck windows, so the duck is measured on the mix.
export const MIX = { cps: 1, cycles: 1, duckAt: 0.25, sendWindow: [0.64, 0.7], orbits: [1, 2, 3, 4], ducked: 1, send: 3 };

export function mixPattern() {
  return stack(
    note(48).s('sine').orbit(1).gain(0.5).attack(0).release(0.01).clip(1),
    note(72).s('sine').orbit(2).gain(0).struct('~ x ~ ~').duckorbit(1).duckdepth(1).duckattack(0.1),
    note(64).s('triangle').orbit(3).gain(0.4).struct('~ ~ x ~').clip(0.25).release(0.01).delay(0.8).delaytime(0.125).delayfeedback(0.5),
    note(55).s('square').orbit(4).gain(0.1).struct('~ ~ x ~').clip(0.25).release(0.01),
  );
}

export function stemPattern() {
  return stack(
    note(48).s('sine').orbit(1).gain(0.3),
    // an orbit effect, which must stay in its orbit's stem
    note(67).s('triangle').orbit(2).gain(0.3).fast(2).delay(0.5),
    note(72).s('sine').orbit(3).gain(0.2).fast(4),
    note(55).s('square').orbit(4).gain(0.1),
  );
}

// PLUG-1: the pattern whose note events drive the hosted CLAP instrument (Node only).
export const PLUGIN_PATTERN = { source: 'note("c4 e4 g4 c5")', cycles: 1, cps: 1, tailSeconds: 0.5 };

export function pluginPattern() {
  return note('c4 e4 g4 c5');
}
