// Test patterns built from Strudel globals only, so each builder can also run
// in the browser page via fn.toString(). Call loadScope() first in Node.
/* global arrange, note, sequence, pure */

export const ARRANGEMENT = { sections: 8, bars: 8 };

export function arrangementPattern() {
  return arrange(...Array.from({ length: 8 }, (_, i) => [8, note(60 + i)]));
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
