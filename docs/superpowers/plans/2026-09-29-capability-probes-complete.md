# Capability Probes, Complete Set: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the remaining capability probes (CLI: ARR-1, AUT-1, MIX-1, EXP-2, TUNE-1, LANG-1; Desktop: PLUG-1; Browser: all 13 cells) and run all three tiers.

**Architecture:** Probe logic that is independent of the engine (test patterns, pattern-level checks, error location parsing, audio measurements) lives in shared modules. Test patterns and pattern checks use only Strudel globals, so the same function runs in Node (after `loadScope()`) and in the browser page (sent as `fn.toString()`). The browser tier serves `website/dist` with cross-origin isolation headers and launches the Chromium headless shell from the Playwright cache. It drives Chromium over the Chrome DevTools Protocol using Node 22's built-in `WebSocket`, with no new dependencies. Each browser probe gets a fresh page. PLUG-1 is a throwaway Rust CLAP host that loads Surge XT.

**Tech Stack:** Node 22.21.1 (`~/.nvm/versions/node/v22.21.1/bin`), pnpm 10.33, Vitest 3, `@strudel/core|mini|tonal|xen|transpiler`, supradough `Dough`, Chromium headless shell (`~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`), Rust/cargo, the `clack-host` crate.

**Spec:** `docs/superpowers/specs/2026-09-28-capability-matrix-design.md` (amended 2026-09-29: browser automation in scope; PLUG-1 uses Surge XT).

**Builds on:** `docs/superpowers/plans/2026-09-28-capability-matrix-foundation.md` (runner, contract, render helpers) and `docs/superpowers/plans/2026-09-29-capability-matrix-followups.md`.

## Global Constraints

- Statuses are exactly `pass | fail | wall | not-run`; `not-run` never counts as a pass.
- A probe that observes zero events or zero signal reports `fail`, never `pass`.
- `wall` requires `notes.evidence`; without it, the runner downgrades the result to `fail`.
- A probe that throws is recorded as `fail`, with the error in `notes.error`.
- Thresholds live only in `capabilities.json`, never inside probes. Threshold comparisons are fail-closed: `!(value >= min)` or `!(value <= max)`.
- A probe measures; it never fixes. Do not modify `packages/`, `website/`, or `src-tauri/`, and never patch `Math.random`.
- `tools/capabilities/` is tooling, not application code.
- Uncommitted user files (root `package.json`, `.npmrc`, `docs/development-baseline.md`, `tools/baseline/`, `packages/core/test/cyclist.test.mjs`, `test/runtime.mjs`, `packages/mini/bench/mini.bench.mjs`) are never staged. Always `git add` explicit paths.
- Work on branch `dev`. Pushing `dev` to `origin` is allowed; never push to `upstream`; never force-push.
- Use Node 22 for every command: prefix with `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" &&`.
- supradough renders at 48000 Hz in Node (`renderPattern` enforces this).
- Loading `@strudel/core` in Node prints "cannot use window: not in browser?". This is known noise.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Verified facts (checked 2026-09-29 in Node)

- `arrange([2, note(60)], [2, note(61)])` repeats after 4 cycles: onsets at cycles 0, 1, 4, 5 have note 60, so there is no hard ending.
- `sequence(0, 7).fmap((k) => ({ i: k })).xen('19edo')` gives `{freq: 220}` and `{freq: 284.0066235}`. `.xen('12ji')` with i=4 gives freq 275 (= 220·5/4).
- `evaluate` from `@strudel/transpiler`:
  - A syntax error on line 3 throws `SyntaxError`, message `"Unexpected token (3:12)"`, `err.loc = { line: 3, column: 12 }` (0-based column).
  - An unknown method throws `TypeError "note(...).s(...).notAFunction is not a function"`, with no `loc`. The stack contains `<anonymous>:3:78`, i.e. a line/column in the transpiled code.
- supradough (`packages/supradough/dough.mjs`) has no buses, sends, or ducking. superdough has `duckorbit` / `duckdepth` / `duckonset` / `duckattack`.
- `renderPatternAudio(pattern, cps, begin, end, sampleRate, maxPolyphony, multiChannelOrbits, downloadName)` (`packages/webaudio/webaudio.mjs:40`) renders through an `OfflineAudioContext` and triggers an `<a download>` click. It does not return the buffer.
- In the web REPL, `evalScope` puts the exports of core, mini, tonal, xen, edo, webaudio and others on `globalThis` (`website/src/repl/util.mjs:70-98`). `window.strudelMirror` is the editor (`setCode`, `evaluate`, `stop`, `repl.state.error`).
- No CLAP/VST3 plugins are installed; Surge XT is not in the Fedora repos. The user installs the official RPM, which puts `Surge XT.clap` in `/usr/lib/clap/`.

---

### Task 1: Shared scope loader, measurement helpers, and the reference-song refactor

**Files:**
- Create: `tools/capabilities/lib/scope.mjs`
- Create: `tools/capabilities/lib/measure.mjs`
- Modify: `tools/capabilities/lib/reference-song.mjs` (use `loadScope`; export the global-only builder)
- Test: `tools/capabilities/test/measure.test.mjs`

**Interfaces:**
- Produces:
  - `loadScope() → Promise<void>` (memoized: `evalScope(core, mini, tonal, xen)` + `miniAllStrings()`)
  - `firstIndexAbove(samples, threshold, from = 0, to = samples.length) → number` (−1 if none)
  - `windowRms(samples, start, end) → number` (indices clamped to the buffer; empty window → 0)
  - `toDb(ratio) → number` (`20·log10(ratio)`; ratio ≤ 0 → `-Infinity`)
  - `estimateFrequency(samples, sampleRate, start, end) → number` (rising zero crossings with linear interpolation; fewer than 2 crossings → `NaN`)
  - `cents(freq, ref) → number` (`1200·log2(freq/ref)`)
  - `decodeFloat32(base64) → Float32Array` (inverse of the page-side encoder in Task 5)
  - `buildReferenceSong()`: a function using only globals (`note`, `s`, `chord`, `sine`, `press`, `add`, `ply`, `rev`) that returns the reference pattern. `referenceSong()` becomes `async () => { await loadScope(); return buildReferenceSong(); }`. `REFERENCE` is unchanged.

- [ ] **Step 1: Write the failing tests**

`tools/capabilities/test/measure.test.mjs`:
```js
import { describe, expect, it } from 'vitest';
import { cents, decodeFloat32, estimateFrequency, firstIndexAbove, toDb, windowRms } from '../lib/measure.mjs';

const sine = (freq, seconds, sampleRate = 48000, amp = 0.5) =>
  Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));

describe('firstIndexAbove', () => {
  it('finds the first sample whose magnitude exceeds the threshold', () => {
    expect(firstIndexAbove(Float32Array.from([0, 0, -0.2, 0.5]), 0.1)).toBe(2);
  });
  it('respects the search window and returns -1 when nothing is found', () => {
    const x = Float32Array.from([0.5, 0, 0, 0.5]);
    expect(firstIndexAbove(x, 0.1, 1, 3)).toBe(-1);
    expect(firstIndexAbove(x, 0.1, 1)).toBe(3);
  });
});

describe('windowRms', () => {
  it('measures a window and clamps its bounds', () => {
    const x = Float32Array.from([1, -1, 1, -1, 0, 0]);
    expect(windowRms(x, 0, 4)).toBe(1);
    expect(windowRms(x, 4, 100)).toBe(0);
    expect(windowRms(x, 3, 3)).toBe(0);
  });
});

describe('toDb and cents', () => {
  it('converts ratios', () => {
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(toDb(0)).toBe(-Infinity);
    expect(cents(440 * Math.pow(2, 1 / 12), 440)).toBeCloseTo(100, 6);
  });
});

describe('estimateFrequency', () => {
  it('measures a 19-EDO step within 0.1 cent', () => {
    const f = 220 * Math.pow(2, 7 / 19);
    const est = estimateFrequency(sine(f, 0.5), 48000, 0, 24000);
    expect(Math.abs(cents(est, f))).toBeLessThan(0.1);
  });
  it('returns NaN for silence', () => {
    expect(estimateFrequency(new Float32Array(4800), 48000, 0, 4800)).toBeNaN();
  });
});

describe('decodeFloat32', () => {
  it('round-trips Float32 bytes through base64', () => {
    const x = Float32Array.from([0.25, -1, 3.5]);
    const b64 = Buffer.from(x.buffer).toString('base64');
    expect(Array.from(decodeFloat32(b64))).toEqual([0.25, -1, 3.5]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tools/capabilities/test/measure.test.mjs`
Expected: FAIL, because `../lib/measure.mjs` cannot be resolved.

- [ ] **Step 3: Implement**

`tools/capabilities/lib/measure.mjs`:
```js
// Audio measurements shared by CLI and browser probes.
export function firstIndexAbove(samples, threshold, from = 0, to = samples.length) {
  for (let i = Math.max(0, from); i < Math.min(to, samples.length); i++) {
    if (Math.abs(samples[i]) > threshold) return i;
  }
  return -1;
}

export function windowRms(samples, start, end) {
  const a = Math.max(0, Math.floor(start));
  const b = Math.min(samples.length, Math.floor(end));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}

export const toDb = (ratio) => (ratio > 0 ? 20 * Math.log10(ratio) : -Infinity);

export const cents = (freq, ref) => 1200 * Math.log2(freq / ref);

// Rising zero crossings with linear interpolation between samples.
export function estimateFrequency(samples, sampleRate, start, end) {
  const crossings = [];
  for (let i = Math.max(1, start); i < Math.min(end, samples.length); i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a < 0 && b >= 0) crossings.push(i - 1 + a / (a - b));
  }
  if (crossings.length < 2) return NaN;
  const periods = crossings.length - 1;
  return (periods * sampleRate) / (crossings.at(-1) - crossings[0]);
}

export function decodeFloat32(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
}
```

`tools/capabilities/lib/scope.mjs`:
```js
// Puts Strudel's pattern functions on globalThis once, like the REPL does.
import { evalScope } from '@strudel/core';
import { miniAllStrings } from '@strudel/mini';

let loaded;

export function loadScope() {
  loaded ??= evalScope(
    import('@strudel/core'),
    import('@strudel/mini'),
    import('@strudel/tonal'),
    import('@strudel/xen'),
  ).then(() => miniAllStrings());
  return loaded;
}
```

In `tools/capabilities/lib/reference-song.mjs`:
- Replace the local `evalScope` / `miniAllStrings` loader with `import { loadScope } from './scope.mjs'`.
- Move the pattern expression into `export function buildReferenceSong() { return note('c,eb,g,<bb c4 d4 eb4>') ... ; }`, keeping the chain byte-for-byte.
- Define `export async function referenceSong() { await loadScope(); return buildReferenceSong(); }`.
- Keep `REFERENCE` and the `/* global ... */` comment.

- [ ] **Step 4: Run the tests and the existing render probes**

Run: `pnpm exec vitest run tools/capabilities` and `node tools/capabilities/run.mjs --tier cli --only EXP-1`
Expected: all tests pass (29 existing + 7 new = 36); EXP-1 still `fail (non-deterministic)`.

- [ ] **Step 5: Revert the regenerated evidence and commit**

```bash
git checkout -- tools/capabilities/results tools/capabilities/MATRIX.md
git add tools/capabilities/lib/scope.mjs tools/capabilities/lib/measure.mjs tools/capabilities/lib/reference-song.mjs tools/capabilities/test/measure.test.mjs
git commit -m "feat(capabilities): shared scope loader and measurement helpers"
```

---

### Task 2: Engine-independent test patterns and checks, plus CLI ARR-1, TUNE-1, LANG-1

**Files:**
- Create: `tools/capabilities/lib/patterns.mjs` (test patterns using only globals)
- Create: `tools/capabilities/lib/checks.mjs` (pure checks and error-location parsing)
- Create: `tools/capabilities/probes/cli/ARR-1.mjs`, `probes/cli/TUNE-1.mjs`, `probes/cli/LANG-1.mjs`
- Test: `tools/capabilities/test/checks.test.mjs`

**Interfaces:**
- Consumes: `loadScope`, `estimateFrequency`, `cents` (Task 1); `renderPattern` (`lib/render.mjs`)
- Produces (all pattern builders use only globals so their `toString()` runs in the page):
  - `ARRANGEMENT = { sections: 8, bars: 8 }`
  - `arrangementPattern() → Pattern`: `arrange(...Array.from({ length: 8 }, (_, i) => [8, note(60 + i)]))`
  - `tuningCases() → { name, pattern, expected: number[] }[]`:
    - 19-EDO: `sequence(...range(0..18)).fmap(k => ({ i: k })).xen('19edo')`, expected `220·2^(k/19)`
    - just intonation: `sequence(...range(0..11)).fmap(k => ({ i: k })).xen('12ji')`, expected `220 × [1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3, 16/9, 15/8][k]`
  - `tuningRenderPattern() → Pattern`: `pure({ i: 7 }).xen('19edo').s('sine').gain(0.5)` (one sustained note; expected `220·2^(7/19)`)
  - `ERROR_CASES`: `[{ name: 'syntax', code: 'note("c e g")\n  .s("sine")\n  .lpf(800 +)\n', line: 3, column: 12 }, { name: 'unknown function', code: 'note("c e g")\n  .s("sine")\n  .notAFunction(2)\n', line: 3, column: 3 }]` (columns are 0-based and point at the offending token: `)` for the syntax case, the `notAFunction` identifier for the unknown one)
  - `checkArrangement(haps, { sections, bars }) → { eventsInSong, wrongSection, eventsAfterEnd }`, where `haps` are onset haps of `arrangementPattern().queryArc(0, sections*bars + bars)`
  - `checkTuning(values, expected) → { count, maxCents }` (values are hap values carrying `freq`)
  - `locateError(err, userLineCount) → { line, column, source } | null`:
    1. `err.loc` → `{ line, column, source: 'loc' }`
    2. otherwise a message suffix `(L:C)` → `source: 'message'`
    3. otherwise the first stack frame matching `<anonymous>:(\d+):(\d+)` whose line ≤ `userLineCount` → `source: 'stack'`
    4. otherwise `null`

- [ ] **Step 1: Write the failing tests**

`tools/capabilities/test/checks.test.mjs`:
```js
import { describe, expect, it } from 'vitest';
import { checkArrangement, checkTuning, locateError } from '../lib/checks.mjs';

const hap = (begin, note) => ({ whole: { begin }, value: { note } });

describe('checkArrangement', () => {
  it('counts wrong sections and events after the end', () => {
    const haps = [hap(0, 60), hap(8, 61), hap(9, 60), hap(64, 60)];
    expect(checkArrangement(haps, { sections: 8, bars: 8 })).toEqual({ eventsInSong: 3, wrongSection: 1, eventsAfterEnd: 1 });
  });
});

describe('checkTuning', () => {
  it('reports the largest deviation in cents', () => {
    const r = checkTuning([{ freq: 220 }, { freq: 440 * Math.pow(2, 2 / 1200) }], [220, 440]);
    expect(r.count).toBe(2);
    expect(r.maxCents).toBeCloseTo(2, 6);
  });
  it('treats a missing frequency as an infinite deviation', () => {
    expect(checkTuning([{}], [220]).maxCents).toBe(Infinity);
  });
  it('treats a count mismatch as an infinite deviation', () => {
    expect(checkTuning([{ freq: 220 }], [220, 440]).maxCents).toBe(Infinity);
  });
});

describe('locateError', () => {
  it('prefers err.loc', () => {
    expect(locateError({ loc: { line: 3, column: 12 }, message: 'x' }, 3)).toEqual({ line: 3, column: 12, source: 'loc' });
  });
  it('falls back to a (line:column) message suffix', () => {
    expect(locateError({ message: 'Unexpected token (2:5)' }, 3)).toEqual({ line: 2, column: 5, source: 'message' });
  });
  it('falls back to the first anonymous stack frame inside the user code', () => {
    const stack = 'TypeError: x\n    at eval (eval at f (file.mjs:1:1), <anonymous>:3:78)';
    expect(locateError({ message: 'x', stack }, 3)).toEqual({ line: 3, column: 78, source: 'stack' });
  });
  it('returns null when nothing locates the error', () => {
    expect(locateError({ message: 'x', stack: 'at <anonymous>:9:1' }, 3)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tools/capabilities/test/checks.test.mjs`
Expected: FAIL, because `../lib/checks.mjs` cannot be resolved.

- [ ] **Step 3: Implement `checks.mjs` and `patterns.mjs`**

`tools/capabilities/lib/checks.mjs`:
```js
// Pure checks shared by the CLI and browser probes. No Strudel imports.
import { cents } from './measure.mjs';

export function checkArrangement(haps, { sections, bars }) {
  const end = sections * bars;
  let eventsInSong = 0;
  let wrongSection = 0;
  let eventsAfterEnd = 0;
  for (const hap of haps) {
    const begin = Number(hap.whole.begin);
    if (begin >= end) {
      eventsAfterEnd++;
      continue;
    }
    eventsInSong++;
    if (hap.value.note !== 60 + Math.floor(begin / bars)) wrongSection++;
  }
  return { eventsInSong, wrongSection, eventsAfterEnd };
}

export function checkTuning(values, expected) {
  if (values.length !== expected.length) return { count: values.length, maxCents: Infinity };
  let maxCents = 0;
  values.forEach((v, k) => {
    const deviation = typeof v.freq === 'number' ? Math.abs(cents(v.freq, expected[k])) : Infinity;
    maxCents = Math.max(maxCents, deviation);
  });
  return { count: values.length, maxCents };
}

export function locateError(err, userLineCount) {
  if (err?.loc) return { line: err.loc.line, column: err.loc.column, source: 'loc' };
  const fromMessage = /\((\d+):(\d+)\)\s*$/.exec(err?.message ?? '');
  if (fromMessage) return { line: Number(fromMessage[1]), column: Number(fromMessage[2]), source: 'message' };
  for (const [, line, column] of String(err?.stack ?? '').matchAll(/<anonymous>:(\d+):(\d+)/g)) {
    if (Number(line) <= userLineCount) return { line: Number(line), column: Number(column), source: 'stack' };
  }
  return null;
}
```
`checks.mjs` imports `measure.mjs`, which is pure JS with no Node-only APIs except `decodeFloat32`. The page never imports modules; only pattern *builders* (`patterns.mjs`) are sent to the page via `toString()`. Checks run in Node on values returned from the page.

`tools/capabilities/lib/patterns.mjs`:
```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tools/capabilities/test/checks.test.mjs`
Expected: 8 passed.

- [ ] **Step 5: Write the three CLI probes**

`tools/capabilities/probes/cli/ARR-1.mjs`:
```js
// ARR-1 (CLI): an 8-section, 64-bar arrangement with correct boundaries and a hard ending.
import { checkArrangement } from '../../lib/checks.mjs';
import { ARRANGEMENT, arrangementPattern } from '../../lib/patterns.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe() {
  await loadScope();
  const { sections, bars } = ARRANGEMENT;
  const haps = arrangementPattern()
    .queryArc(0, sections * bars + bars)
    .filter((h) => h.hasOnset());
  const r = checkArrangement(haps, ARRANGEMENT);
  const metrics = { sections, bars: sections * bars, ...r };
  const notes = { construct: 'arrange()' };
  if (r.eventsInSong === 0) return { status: 'fail', metrics: { ...metrics, headline: 'no events' }, notes };
  if (r.wrongSection > 0) {
    return { status: 'fail', metrics: { ...metrics, headline: 'wrong boundaries' }, notes: { ...notes, error: `${r.wrongSection} events in the wrong section` } };
  }
  if (r.eventsAfterEnd > 0) {
    return {
      status: 'fail',
      metrics: { ...metrics, headline: 'no hard ending' },
      notes: { ...notes, error: `arrange() loops: ${r.eventsAfterEnd} events after bar ${sections * bars}` },
    };
  }
  return { status: 'pass', metrics: { ...metrics, headline: `${sections} sections, ${sections * bars} bars` }, notes };
}
```

`tools/capabilities/probes/cli/TUNE-1.mjs`:
```js
// TUNE-1 (CLI): 19-EDO and just intonation in pattern code; pattern and rendered pitch within maxCents.
import { checkTuning } from '../../lib/checks.mjs';
import { cents, estimateFrequency } from '../../lib/measure.mjs';
import { TUNING_RENDER_EXPECTED, tuningCases, tuningRenderPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const cases = tuningCases().map(({ name, pattern, expected }) => {
    const values = pattern.queryArc(0, 1).map((h) => h.value);
    return { name, ...checkTuning(values, expected) };
  });
  const out = renderPattern(tuningRenderPattern(), { cps: 1, cycles: 1, tail: 0 });
  const measured = estimateFrequency(out.left, out.sampleRate, 4800, 43200);
  const renderedCents = Math.abs(cents(measured, TUNING_RENDER_EXPECTED));
  const worst = Math.max(...cases.map((c) => c.maxCents), renderedCents);
  const metrics = { cases, renderedFreq: measured, renderedCents, maxCents: worst };
  if (thresholds.maxCents == null) return { status: 'fail', metrics, notes: { error: 'threshold maxCents missing' } };
  if (!(worst <= thresholds.maxCents)) {
    return { status: 'fail', metrics: { ...metrics, headline: `${worst.toFixed(2)} cents off` }, notes: { error: `max deviation ${worst} > ${thresholds.maxCents} cents` } };
  }
  return { status: 'pass', metrics: { ...metrics, headline: `max ${worst.toFixed(3)} cents` }, notes: {} };
}
```
Note: `worst` is `NaN` when the render is silent (`estimateFrequency` returns NaN, and `Math.max` then gives NaN), and `!(NaN <= x)` fails closed.

`tools/capabilities/probes/cli/LANG-1.mjs`:
```js
// LANG-1 (CLI): a syntax error and an unknown function report the exact line and column.
import { evaluate } from '@strudel/transpiler';
import { locateError } from '../../lib/checks.mjs';
import { ERROR_CASES } from '../../lib/patterns.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe() {
  await loadScope();
  const cases = [];
  for (const c of ERROR_CASES) {
    let err = null;
    try {
      await evaluate(c.code);
    } catch (e) {
      err = e;
    }
    const lines = c.code.split('\n').length;
    const where = err ? locateError(err, lines) : null;
    const exact = !!where && where.line === c.line && where.column === c.column;
    cases.push({ name: c.name, message: err ? String(err.message) : null, expected: { line: c.line, column: c.column }, reported: where, exact });
  }
  const exactCount = cases.filter((c) => c.exact).length;
  const metrics = { cases, exact: exactCount, headline: `${exactCount}/${cases.length} exact` };
  if (cases.some((c) => c.message === null)) return { status: 'fail', metrics, notes: { error: 'a broken program raised no error' } };
  if (exactCount < cases.length) {
    return { status: 'fail', metrics, notes: { error: cases.filter((c) => !c.exact).map((c) => `${c.name}: reported ${JSON.stringify(c.reported)}`).join('; ') } };
  }
  return { status: 'pass', metrics, notes: {} };
}
```

- [ ] **Step 6: Run the three probes**

Run: `node tools/capabilities/run.mjs --tier cli --only ARR-1 && node tools/capabilities/run.mjs --tier cli --only TUNE-1 && node tools/capabilities/run.mjs --tier cli --only LANG-1`
Expected:
- ARR-1: `fail (no hard ending)`.
- TUNE-1: a status with the max cents. If it fails on the rendered pitch, report the measured frequency.
- LANG-1: `fail (1/2 exact)`. The unknown-function case reports column 78 from the stack.

Record each result object in the report.

- [ ] **Step 7: Revert the evidence and commit**

```bash
git checkout -- tools/capabilities/results tools/capabilities/MATRIX.md
git add tools/capabilities/lib/patterns.mjs tools/capabilities/lib/checks.mjs tools/capabilities/test/checks.test.mjs tools/capabilities/probes/cli/ARR-1.mjs tools/capabilities/probes/cli/TUNE-1.mjs tools/capabilities/probes/cli/LANG-1.mjs
git commit -m "feat(capabilities): CLI ARR-1, TUNE-1 and LANG-1 probes"
```

---

### Task 3: CLI AUT-1, MIX-1, EXP-2

**Files:**
- Modify: `tools/capabilities/lib/patterns.mjs` (add three builders)
- Modify: `tools/capabilities/lib/checks.mjs` (add `analyzeSteps`, `duckDrop`, `stemResidual`)
- Modify: `tools/capabilities/test/checks.test.mjs`
- Create: `tools/capabilities/probes/cli/AUT-1.mjs`, `probes/cli/MIX-1.mjs`, `probes/cli/EXP-2.mjs`

**Interfaces:**
- Produces:
  - `AUTOMATION = { steps: 16, cps: 1 }`
  - `automationPattern()`: `note(69).s('sine').fast(16).clip(0.5).attack(0).release(0.002).gain(saw.range(0.2, 1))`
  - `DUCK = { cps: 1, triggerAt: 0.25 }`
  - `duckPattern()`: `stack(note(48).s('sine').orbit(1).gain(0.5).attack(0).release(0.01).clip(1), note(72).s('sine').orbit(2).gain(0).struct('~ x ~ ~').duckorbit(1).duckdepth(1).duckattack(0.1))`
  - `stemPattern()`: `stack(note(48).s('sine').orbit(1).gain(0.3), note(67).s('triangle').orbit(2).gain(0.3).fast(2), note(72).s('sine').orbit(3).gain(0.2).fast(4), note(55).s('square').orbit(4).gain(0.1))`. It is synth-only with no noise and no delay, so it is deterministic.
  - `analyzeSteps(samples, sampleRate, { steps, cps }) → { onsets, maxErrorMs, rms: number[], increasing: boolean }`. Onset k is expected at sample `round(k·sampleRate/(steps·cps))`. Search `[expected − 5 ms, expected + 5 ms)` with `firstIndexAbove(…, 1e-4)`. A missing onset gives an error of `Infinity`. `rms[k]` is `windowRms` over the middle half of the note (the note lasts half a step). `increasing` means each `rms[k] > rms[k−1]`.
  - `duckDrop(samples, sampleRate, { cps, triggerAt }) → { beforeRms, afterRms, dropDb }`. The before window is `[triggerAt − 0.05 s, triggerAt − 0.01 s)`; the after window is `[triggerAt + 0.005 s, triggerAt + 0.025 s)`. `dropDb = −toDb(after/before)`.
  - `stemResidual(mix, stems) → { residualDbfs }`: `20·log10(max |mix[i] − Σ stems[i]|)`. Full silence gives −Infinity.

- [ ] **Step 1: Write the failing tests** (append to `checks.test.mjs`)

```js
import { analyzeSteps, duckDrop, stemResidual } from '../lib/checks.mjs';

describe('analyzeSteps', () => {
  it('finds onsets on the grid and a rising level', () => {
    const sr = 1600;
    const x = new Float32Array(sr);
    for (let k = 0; k < 16; k++) for (let i = 0; i < 50; i++) x[k * 100 + i] = 0.1 * (k + 1) * (i % 2 ? 1 : -1);
    const r = analyzeSteps(x, sr, { steps: 16, cps: 1 });
    expect(r.maxErrorMs).toBe(0);
    expect(r.increasing).toBe(true);
  });
  it('reports Infinity when an onset is missing', () => {
    expect(analyzeSteps(new Float32Array(1600), 1600, { steps: 16, cps: 1 }).maxErrorMs).toBe(Infinity);
  });
});

describe('duckDrop', () => {
  it('measures the level drop after the trigger in dB', () => {
    const sr = 1000;
    const x = new Float32Array(sr).map((_, i) => (i < 250 ? 1 : 0.5) * (i % 2 ? 1 : -1));
    expect(duckDrop(x, sr, { cps: 1, triggerAt: 0.25 }).dropDb).toBeCloseTo(6.0206, 3);
  });
});

describe('stemResidual', () => {
  it('is -Infinity when stems sum exactly to the mix', () => {
    const a = Float32Array.from([0.5, -0.25]);
    const b = Float32Array.from([0.25, 0.25]);
    expect(stemResidual(Float32Array.from([0.75, 0]), [a, b]).residualDbfs).toBe(-Infinity);
  });
  it('reports the worst sample difference in dBFS', () => {
    expect(stemResidual(Float32Array.from([0.1]), [Float32Array.from([0])]).residualDbfs).toBeCloseTo(-20, 6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tools/capabilities/test/checks.test.mjs`
Expected: FAIL, because `analyzeSteps` is not exported.

- [ ] **Step 3: Implement** (append to `checks.mjs`; add the imports `firstIndexAbove`, `windowRms`, `toDb` from `./measure.mjs`)

```js
export function analyzeSteps(samples, sampleRate, { steps, cps }) {
  const stepLen = sampleRate / (steps * cps);
  const slack = Math.round(0.005 * sampleRate);
  const onsets = [];
  const rms = [];
  let maxErrorMs = 0;
  for (let k = 0; k < steps; k++) {
    const expected = Math.round(k * stepLen);
    const found = firstIndexAbove(samples, 1e-4, expected - slack, expected + slack);
    const errorMs = found < 0 ? Infinity : (Math.abs(found - expected) / sampleRate) * 1000;
    maxErrorMs = Math.max(maxErrorMs, errorMs);
    onsets.push({ expected, found, errorMs });
    rms.push(windowRms(samples, expected + stepLen / 8, expected + (3 * stepLen) / 8));
  }
  const increasing = rms.every((v, k) => k === 0 || v > rms[k - 1]);
  return { onsets, maxErrorMs, rms, increasing };
}

export function duckDrop(samples, sampleRate, { triggerAt }) {
  const at = (s) => Math.round(s * sampleRate);
  const beforeRms = windowRms(samples, at(triggerAt - 0.05), at(triggerAt - 0.01));
  const afterRms = windowRms(samples, at(triggerAt + 0.005), at(triggerAt + 0.025));
  return { beforeRms, afterRms, dropDb: -toDb(afterRms / beforeRms) };
}

export function stemResidual(mix, stems) {
  let worst = 0;
  for (let i = 0; i < mix.length; i++) {
    let sum = 0;
    for (const stem of stems) sum += stem[i] ?? 0;
    worst = Math.max(worst, Math.abs(mix[i] - sum));
  }
  return { residualDbfs: toDb(worst) };
}
```
Note: in the `duckDrop` test, the before window [200, 240) is at level 1 and the after window [255, 275) at level 0.5, which gives a 6.02 dB drop.

Append to `patterns.mjs` (add `saw`, `stack` to the `/* global */` line):
```js
export const AUTOMATION = { steps: 16, cps: 1 };

export function automationPattern() {
  return note(69).s('sine').fast(16).clip(0.5).attack(0).release(0.002).gain(saw.range(0.2, 1));
}

export const DUCK = { cps: 1, triggerAt: 0.25 };

export function duckPattern() {
  return stack(
    note(48).s('sine').orbit(1).gain(0.5).attack(0).release(0.01).clip(1),
    note(72).s('sine').orbit(2).gain(0).struct('~ x ~ ~').duckorbit(1).duckdepth(1).duckattack(0.1),
  );
}

export function stemPattern() {
  return stack(
    note(48).s('sine').orbit(1).gain(0.3),
    note(67).s('triangle').orbit(2).gain(0.3).fast(2),
    note(72).s('sine').orbit(3).gain(0.2).fast(4),
    note(55).s('square').orbit(4).gain(0.1),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tools/capabilities/test/checks.test.mjs`
Expected: 13 passed.

- [ ] **Step 5: Write the three probes**

`tools/capabilities/probes/cli/AUT-1.mjs`:
```js
// AUT-1 (CLI): gain automation steps land within maxErrorMs of their grid time, with values applied.
import { analyzeSteps } from '../../lib/checks.mjs';
import { AUTOMATION, automationPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const out = renderPattern(automationPattern(), { cps: AUTOMATION.cps, cycles: 1, tail: 0.05 });
  const r = analyzeSteps(out.left, out.sampleRate, AUTOMATION);
  const metrics = { events: out.eventCount, maxErrorMs: r.maxErrorMs, increasing: r.increasing, onsets: r.onsets, headline: `${r.maxErrorMs.toFixed(3)} ms` };
  const notes = { resolution: `stepped: ${AUTOMATION.steps} values per cycle, one per event` };
  if (out.eventCount === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no events rendered' } };
  if (thresholds.maxErrorMs == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold maxErrorMs missing' } };
  if (!r.increasing) return { status: 'fail', metrics, notes: { ...notes, error: 'automated gain values were not applied (levels not rising)' } };
  if (!(r.maxErrorMs <= thresholds.maxErrorMs)) return { status: 'fail', metrics, notes: { ...notes, error: `max timing error ${r.maxErrorMs} ms` } };
  return { status: 'pass', metrics, notes };
}
```

`tools/capabilities/probes/cli/MIX-1.mjs`:
```js
// MIX-1 (CLI): a trigger on orbit 2 ducks orbit 1 by at least minDuckDb.
import { duckDrop } from '../../lib/checks.mjs';
import { DUCK, duckPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe({ thresholds }) {
  await loadScope();
  const out = renderPattern(duckPattern(), { cps: DUCK.cps, cycles: 1, tail: 0 });
  const r = duckDrop(out.left, out.sampleRate, DUCK);
  const metrics = { events: out.eventCount, ...r, headline: `${r.dropDb.toFixed(1)} dB duck` };
  const notes = { engine: 'supradough', scope: 'ducking only; buses and sends are not separately observable in a stereo mix' };
  if (out.eventCount === 0 || r.beforeRms === 0) return { status: 'fail', metrics, notes: { ...notes, error: 'no signal before the trigger' } };
  if (thresholds.minDuckDb == null) return { status: 'fail', metrics, notes: { ...notes, error: 'threshold minDuckDb missing' } };
  if (!(r.dropDb >= thresholds.minDuckDb)) return { status: 'fail', metrics, notes: { ...notes, error: `ducking ${r.dropDb.toFixed(2)} dB < ${thresholds.minDuckDb} dB` } };
  return { status: 'pass', metrics, notes };
}
```

`tools/capabilities/probes/cli/EXP-2.mjs`:
```js
// EXP-2 (CLI): a stem-export API exists, and per-orbit renders sum to the mix.
import { stemResidual } from '../../lib/checks.mjs';
import { stemPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

const ORBITS = [1, 2, 3, 4];

async function stemApis() {
  const modules = { '@strudel/core': await import('@strudel/core'), '@strudel/webaudio': await import('@strudel/webaudio'), supradough: await import('../../../../packages/supradough/dough.mjs') };
  return Object.entries(modules).flatMap(([name, m]) => Object.keys(m).filter((k) => /stem/i.test(k)).map((k) => `${name}.${k}`));
}

export async function probe({ thresholds }) {
  await loadScope();
  const opts = { cps: 1, cycles: 2, tail: 0.5 };
  const mix = renderPattern(stemPattern(), opts);
  const stems = ORBITS.map((o) => renderPattern(stemPattern().filterValues((v) => v.orbit === o), opts).left);
  const { residualDbfs } = stemResidual(mix.left, stems);
  const apis = await stemApis();
  const metrics = { stemApis: apis, orbits: ORBITS.length, residualDbfs, headline: apis.length ? `${apis.length} stem API(s)` : 'no stem API' };
  if (mix.eventCount === 0) return { status: 'fail', metrics, notes: { error: 'no events rendered' } };
  if (thresholds.maxResidualDbfs == null) return { status: 'fail', metrics, notes: { error: 'threshold maxResidualDbfs missing' } };
  if (!apis.length) {
    return { status: 'fail', metrics, notes: { error: 'no stem export API', feasibility: `per-orbit renders sum to the mix at ${residualDbfs} dBFS` } };
  }
  if (!(residualDbfs <= thresholds.maxResidualDbfs)) return { status: 'fail', metrics, notes: { error: `stem residual ${residualDbfs} dBFS` } };
  return { status: 'pass', metrics, notes: {} };
}
```
If `import('@strudel/webaudio')` throws in Node (it needs Web Audio globals), catch that per module, record `notes.skippedModules`, and continue. Do not fail the probe for that reason.

- [ ] **Step 6: Run the probes**

Run: `node tools/capabilities/run.mjs --tier cli --only AUT-1 && node tools/capabilities/run.mjs --tier cli --only MIX-1 && node tools/capabilities/run.mjs --tier cli --only EXP-2`
Expected:
- AUT-1: a status with the max error in ms.
- MIX-1: `fail`, about 0 dB, because supradough has no ducking.
- EXP-2: `fail (no stem API)`, with a feasibility residual.

Record the result objects.

- [ ] **Step 7: Revert the evidence and commit**

```bash
git checkout -- tools/capabilities/results tools/capabilities/MATRIX.md
git add tools/capabilities/lib/patterns.mjs tools/capabilities/lib/checks.mjs tools/capabilities/test/checks.test.mjs tools/capabilities/probes/cli/AUT-1.mjs tools/capabilities/probes/cli/MIX-1.mjs tools/capabilities/probes/cli/EXP-2.mjs
git commit -m "feat(capabilities): CLI AUT-1, MIX-1 and EXP-2 probes"
```

---

### Task 4: Browser harness and browser BUILD-0

**Files:**
- Create: `tools/capabilities/lib/browser/server.mjs`
- Create: `tools/capabilities/lib/browser/chromium.mjs`
- Create: `tools/capabilities/lib/browser/cdp.mjs`
- Modify: `tools/capabilities/run.mjs` (browser tier runs probes when `--ingest` is absent)
- Modify: `tools/capabilities/README.md`
- Create: `tools/capabilities/probes/browser/BUILD-0.mjs`
- Test: `tools/capabilities/test/browser-server.test.mjs`, `tools/capabilities/test/chromium.test.mjs`

**Interfaces:**
- `startStaticServer(root) → Promise<{ url, close() }>`:
  - listens on `127.0.0.1:0` and serves files under `root`;
  - a directory resolves to `index.html`;
  - unknown path → 404; any path escaping `root` → 403;
  - every response carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`;
  - MIME types by extension: html, js/mjs, css, json, wasm, svg, png, jpg, woff2, wav, mp3, ogg, txt; anything else is `application/octet-stream`.
- `findChromium(cacheDir = ~/.cache/ms-playwright) → string | null`: the newest `chromium_headless_shell-<N>/chrome-headless-shell-linux64/chrome-headless-shell` by numeric N, if the file exists.
- `launchChromium(executable, userDataDir) → Promise<{ port, close() }>`:
  - spawns with `--headless --remote-debugging-port=0 --user-data-dir=<dir> --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check`;
  - reads `DevTools listening on ws://127.0.0.1:<port>/…` from stderr, with a 30 s timeout;
  - `close()` kills the process and removes `userDataDir`.
- `openPage(port, url) → Promise<Page>`:
  - `PUT http://127.0.0.1:<port>/json/new?<url>` → `webSocketDebuggerUrl`;
  - connects with the global `WebSocket` and enables `Runtime`, `Log` and `Page`;
  - `Page = { evaluate(fnOrSource, arg, { timeoutMs = 120000 } = {}) → Promise<any>, click(x, y), errors: string[], close() }`.
  - `evaluate` sends `Runtime.evaluate` with `expression: \`(${source})(${JSON.stringify(arg)})\``, `awaitPromise: true`, `returnByValue: true`.
    - `fnOrSource` may be a function (its `toString()` is used) or a string.
    - An `exceptionDetails` result rejects with an `Error` whose message is `exceptionDetails.exception.description ?? exceptionDetails.text`.
  - `errors` collects `Runtime.exceptionThrown` and `Log.entryAdded` entries of level `error`.
  - `click` dispatches mousePressed/mouseReleased via `Input.dispatchMouseEvent` (the REPL initializes audio on the first mousedown).
- `waitForRepl(page, timeoutMs = 60000)`: polls `!!window.strudelMirror` every 250 ms, then calls `page.click(5, 5)`.
- Browser ctx: `ctx.page` (a fresh page per probe, already waited and clicked) and `ctx.dist` (`{ path, builtAt }`).
- run.mjs browser tier without `--ingest`:
  - if `website/dist/index.html` is missing, every browser cell is `not-run` (reason `website/dist missing: run pnpm build`);
  - if `findChromium()` is null, every cell is `not-run` (reason `no Chromium headless shell in ~/.cache/ms-playwright`);
  - otherwise start the server and Chromium once, give each probe a fresh page, and close the page after the probe;
  - `probes/browser/<ID>.mjs` are Node modules like the other tiers;
  - always close the server and Chromium in `finally`.

- [ ] **Step 1: Write the failing tests**

`tools/capabilities/test/browser-server.test.mjs`:
```js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticServer } from '../lib/browser/server.mjs';

// fetch() normalizes '..' away, so path escapes need a raw request.
const rawStatus = (url, path) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    request({ host: u.hostname, port: u.port, path }, (r) => {
      r.resume();
      resolve(r.statusCode);
    })
      .on('error', reject)
      .end();
  });

let server;
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'caps-server-'));
  writeFileSync(join(root, 'index.html'), '<p>hi</p>');
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'x.wasm'), 'w');
  server = await startStaticServer(root);
});
afterAll(() => server.close());

describe('startStaticServer', () => {
  it('serves index.html with isolation headers', async () => {
    const r = await fetch(server.url + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
  });
  it('serves wasm with its MIME type', async () => {
    const r = await fetch(server.url + '/a/x.wasm');
    expect(r.headers.get('content-type')).toBe('application/wasm');
  });
  it('returns 404 for missing files and 403 for escapes', async () => {
    expect((await fetch(server.url + '/nope.js')).status).toBe(404);
    expect(await rawStatus(server.url, '/../../etc/passwd')).toBe(403);
  });
});
```

`tools/capabilities/test/chromium.test.mjs`:
```js
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChromium } from '../lib/browser/chromium.mjs';

const shell = (root, n) => {
  const dir = join(root, `chromium_headless_shell-${n}`, 'chrome-headless-shell-linux64');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'chrome-headless-shell'), '');
  return join(dir, 'chrome-headless-shell');
};

describe('findChromium', () => {
  it('picks the highest numbered headless shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'caps-pw-'));
    shell(root, 1223);
    const newest = shell(root, 1234);
    mkdirSync(join(root, 'chromium-9999'));
    expect(findChromium(root)).toBe(newest);
  });
  it('returns null when none exists', () => {
    expect(findChromium(mkdtempSync(join(tmpdir(), 'caps-pw-')))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tools/capabilities/test/browser-server.test.mjs tools/capabilities/test/chromium.test.mjs`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `server.mjs`, `chromium.mjs` (with `findChromium` and `launchChromium`), and `cdp.mjs` (with `openPage` and `waitForRepl`) to the interfaces above**

Write each module to the exact contracts above, using only `node:http`, `node:fs`, `node:path`, `node:child_process`, `node:os` and the global `WebSocket`/`fetch`. In `cdp.mjs`:
- keep a message id counter and a `Map` of pending promises;
- reject all pending calls when the socket closes;
- apply `timeoutMs` per `evaluate` call and reject with `Error('evaluate timed out after <ms> ms')`.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec vitest run tools/capabilities/test/browser-server.test.mjs tools/capabilities/test/chromium.test.mjs`
Expected: 5 passed.

- [ ] **Step 5: Wire the browser tier into `run.mjs` and write the browser BUILD-0 probe**

`tools/capabilities/probes/browser/BUILD-0.mjs`:
```js
// BUILD-0 (browser): the production build loads, the REPL starts, and a pattern evaluates without error.
export async function probe({ page, dist }) {
  const result = await page.evaluate(async () => {
    const m = window.strudelMirror;
    m.setCode('note("c4").s("sine").gain(0.01)');
    await m.evaluate();
    await new Promise((r) => setTimeout(r, 1000));
    const error = String(m.repl.state.error || '');
    m.stop();
    return { error };
  });
  const metrics = { builtAt: dist.builtAt, headline: `dist ${dist.builtAt.slice(0, 10)}` };
  if (result.error) return { status: 'fail', metrics, notes: { error: result.error } };
  if (page.errors.length) return { status: 'fail', metrics, notes: { error: page.errors.slice(0, 5).join('\n') } };
  return { status: 'pass', metrics, notes: { scope: 'uses the existing website/dist; does not rebuild' } };
}
```
Update README: the browser tier now runs automatically; `--ingest` is kept for manual browser results; the prerequisites are `pnpm build` and the Playwright Chromium cache.

- [ ] **Step 6: Run the browser BUILD-0**

Run: `node tools/capabilities/run.mjs --tier browser --only BUILD-0`
Expected: `[browser] BUILD-0: pass`. If it fails, report `notes.error` and the page errors verbatim.

- [ ] **Step 7: Revert the evidence and commit**

```bash
git checkout -- tools/capabilities/results tools/capabilities/MATRIX.md 2>/dev/null; rm -f tools/capabilities/results/*-browser.json
git add tools/capabilities/lib/browser tools/capabilities/run.mjs tools/capabilities/README.md tools/capabilities/probes/browser/BUILD-0.mjs tools/capabilities/test/browser-server.test.mjs tools/capabilities/test/chromium.test.mjs
git commit -m "feat(capabilities): automated browser tier over the DevTools protocol"
```

---

### Task 5: Browser offline and API probes (EXP-1, AUT-1, MIX-1, TUNE-1, ARR-1, LANG-1, EXP-2, CUE-1, SYNC-1)

**Files:**
- Create: `tools/capabilities/lib/browser/page-render.mjs`: `renderInPage(page, builderFn, { cps, cycles, sampleRate = 48000 }) → { left: Float32Array, length, sampleRate, hash }`
- Create: `tools/capabilities/probes/browser/{EXP-1,AUT-1,MIX-1,TUNE-1,ARR-1,LANG-1,EXP-2,CUE-1,SYNC-1}.mjs`

**Interfaces:**
- `renderInPage` evaluates in the page an async function that:
  1. builds the pattern with `(${builderFn.toString()})()`, using the page's globals;
  2. wraps `OfflineAudioContext.prototype.startRendering` to capture the promise it returns, and wraps `HTMLAnchorElement.prototype.click` to skip anchors that have a `download` attribute;
  3. calls the global `renderPatternAudio(pattern, cps, 0, cycles, sampleRate, 128, false, 'probe')` and awaits the captured `AudioBuffer`;
  4. restores both prototypes in `finally`;
  5. returns `{ b64: <base64 of the left channel's Float32 bytes>, length, sampleRate, hash: <FNV-1a 32-bit over the left channel's Uint32 view, hex> }`.

  Node decodes the result with `decodeFloat32`. If `renderPatternAudio` is not a global in the page, throw `Error('renderPatternAudio not in page scope')`.
- The probes reuse the Task 2/3 builders and checks with the same logic as their CLI counterparts:
  - EXP-1 renders `buildReferenceSong` twice in the same page. It compares `hash` and `length` and checks `rms ≥ minRms` on the first render, using the browser thresholds.
  - AUT-1 renders `automationPattern` with `AUTOMATION`.
  - MIX-1 renders `duckPattern` with `DUCK`. It passes if `dropDb ≥ minDuckDb`; superdough implements ducking.
  - TUNE-1 evaluates the `tuningCases()` pattern values in the page. It returns `{ name, values, expected }` per case, runs `checkTuning` in Node, and also renders `tuningRenderPattern` and estimates its frequency.
  - ARR-1 evaluates `arrangementPattern().queryArc(...)` in the page and returns `[begin, note]` pairs for onset haps. It then runs `checkArrangement` in Node on `{ whole: { begin }, value: { note } }` objects.
  - LANG-1, for each `ERROR_CASES` entry:
    - `m.setCode(code); await m.evaluate();`
    - it reads `m.repl.state.error` and returns `{ message, loc, stack }`;
    - `locateError` runs in Node.
  - EXP-2 (opt):
    - collects the page globals matching `/stem/i`, and notes that `renderPatternAudio` has a `multiChannelOrbits` parameter but renders to a 2-channel context;
    - with no stem API it returns `fail` "no stem export API".
  - CUE-1 (opt):
    - records `typeof AudioContext.prototype.setSinkId`, plus globals matching `/cue|sink/i`;
    - with no per-pattern cue routing it returns `fail`, notes `error: 'no per-pattern cue output; one output device for all patterns'`, and `platform: { setSinkId }`;
    - if `setSinkId` is missing, it returns `wall` with evidence `AudioContext.setSinkId unavailable in this browser`.
  - SYNC-1 (opt) returns `not-run` with reason `headless Chromium has no MIDI output devices`.
- Browser thresholds come from `capabilities.json`:
  - Missing ones must fail closed.
  - Add `"browser": { "minRms": 0.001 }` to EXP-1's thresholds, and update the spec's EXP-1 row note in the same commit ("minRms applies to CLI and browser").

- [ ] **Step 1: Implement `page-render.mjs`**, then verify it with a one-off run: a temporary probe file renders `() => note(69).s('sine')` for 1 cycle and logs `length` and the decoded RMS. Delete the temporary file afterwards.
- [ ] **Step 2: Write the nine probes** to the interfaces above, following the CLI probes' status and metrics shapes, with fail-closed thresholds.
- [ ] **Step 3: Run each probe** with `node tools/capabilities/run.mjs --tier browser --only <ID>` and record every result object in the report.
- [ ] **Step 4: Run** `pnpm exec vitest run tools/capabilities` (all pass).
- [ ] **Step 5: Revert the evidence and commit** (`capabilities.json`, the spec edit, `page-render.mjs`, the nine probes): `feat(capabilities): browser offline and API probes`.

---

### Task 6: Browser live probes (PERF-1, LIVE-1)

**Files:**
- Create: `tools/capabilities/probes/browser/PERF-1.mjs`, `tools/capabilities/probes/browser/LIVE-1.mjs`

**Interfaces:**
- PERF-1 (browser thresholds `{ minVoices: 64 }`):
  - In the page, instrument `AudioScheduledSourceNode.prototype.start`: record `when` and `context.currentTime`, and count late starts (`when < currentTime`).
  - Connect an `AnalyserNode` tap to measure the output RMS every 250 ms (`getFloatTimeDomainData`). Hook `AudioNode.prototype.connect` for nodes that connect to `context.destination`, the same technique as `tools/baseline/browser-instrumentation.js`, but reimplemented here because those files are not committed.
  - Play `stack(...Array.from({ length: V }, (_, k) => note(36 + (k % 48)))).s('sawtooth').lpf(2000).attack(0.01).release(0.05).clip(1).gain(0.2 / V)` at `setcps(0.5)`, so V voices sound continuously for 60 s. V = `thresholds.minVoices`.
  - Metrics: `voices`, `starts`, `late`, `minLeadMs`, `silentWindows` (RMS windows equal to 0 after the first second), `durationS`.
  - Pass iff `starts > 0`, `late === 0` and `silentWindows === 0`.
  - `notes.scope: 'headless Chromium, fake audio device: measures scheduling lateness and rendered signal, not DAC underruns'`.
- LIVE-1 (browser thresholds `{ maxGapFrames: 128 }`):
  - Play `note("c4").s("sine").fast(8).gain(0.05).release(0.01)` with the same start instrumentation.
  - After 3 s, `setCode('note("c4").s("sine").fast(8).gain(0.05).release(0.01).lpf(800 +)')` and `evaluate()`. The error is expected. Continue for 3 s, then stop.
  - Metrics:
    - `errorReported` (`m.repl.state.error` is set);
    - `startsBefore` and `startsAfter` the failed evaluate;
    - `maxGapFrames`: the largest deviation of consecutive start-time deltas from the event grid `1 / (cps × 8)` seconds (0.25 s at the default cps 0.5), times the context sample rate;
    - `sameFrequencyAfter`: every start after the error has the pre-error oscillator frequency.
  - Pass iff `errorReported`, `startsAfter > 0`, `sameFrequencyAfter`, and `maxGapFrames ≤ maxGapFrames`.

- [ ] **Step 1: Write both probes** to these interfaces. Evaluate page code through `ctx.page.evaluate` with `timeoutMs` above the run length (PERF-1: 90000).
- [ ] **Step 2: Run** `node tools/capabilities/run.mjs --tier browser --only PERF-1` and `--only LIVE-1`; record the result objects.
- [ ] **Step 3: Revert the evidence and commit**: `feat(capabilities): browser PERF-1 and LIVE-1 live probes`.

---

### Task 7: Desktop PLUG-1: CLAP hosting spike with Surge XT

**Files:**
- Create: `tools/capabilities/spikes/clap-host/Cargo.toml`, `tools/capabilities/spikes/clap-host/src/main.rs`
- Create: `tools/capabilities/spikes/clap-host/.gitignore` (`target/`)
- Create: `tools/capabilities/probes/desktop/PLUG-1.mjs`

**Interfaces:**
- The spike binary is `clap-host <plugin.clap> <out.json>`. It must:
  1. load the bundle with the `clack-host` crate (pin the newest published version that builds with the local toolchain, and record it in the report);
  2. list its plugin descriptors;
  3. instantiate the first instrument at 48000 Hz with a 512-frame block;
  4. activate it and start processing;
  5. send a note-on (key 60, velocity 1.0) at frame 0 and a note-off after 24000 frames;
  6. process 48000 frames of stereo output;
  7. write JSON `{ pluginId, pluginName, frames, rms, peak }`.

  On any failure it exits non-zero with the error on stderr. It must not depend on Tauri. This is standalone evidence that a Rust backend (as in the Tauri app) can host CLAP.
- `PLUG-1.mjs` (desktop):
  - if `/usr/lib/clap/Surge XT.clap` (or `/usr/lib64/clap/Surge XT.clap`, or `~/.clap/Surge XT.clap`) is missing → `not-run`, with reason `Surge XT not installed (see follow-ups doc for the install command)`;
  - otherwise run `cargo run --release --manifest-path tools/capabilities/spikes/clap-host/Cargo.toml -- <plugin> <tmp.json>` with `timeoutMs` from thresholds (add `"desktop": { "timeoutMs": 1200000 }` to PLUG-1 in capabilities.json);
  - pass iff the exit code is 0 and `rms > 0`; headline `Surge XT via clack-host`;
  - a cargo or runtime failure → `fail` with `notes.logTail`;
  - `wall` only if the failure is shown to be a platform limit, with evidence (not expected).

- [ ] **Step 1: Write the spike** to the contract. If the clack-host API differs from what you expect, read the crate's docs and examples from `~/.cargo/registry` after the first `cargo fetch`.
- [ ] **Step 2: Build it** with `cargo build --release --manifest-path tools/capabilities/spikes/clap-host/Cargo.toml` (it may take many minutes on this disk).
- [ ] **Step 3: Write `PLUG-1.mjs`**, then run `node tools/capabilities/run.mjs --tier desktop --only PLUG-1`. Without Surge XT, expect `not-run`. If Surge XT is installed, expect a pass or a genuine failure.
- [ ] **Step 4: Verify** that `git status --short tools/capabilities/spikes` shows no `target/`.
- [ ] **Step 5: Revert the evidence and commit** the spike sources, `PLUG-1.mjs` and `capabilities.json`: `feat(capabilities): desktop PLUG-1 CLAP hosting spike`.

---

### Task 8: Full run of all three tiers, evidence, and follow-ups

**Files:**
- Generated: `tools/capabilities/results/*`, `tools/capabilities/MATRIX.md`
- Modify: `docs/superpowers/plans/2026-09-29-capability-matrix-followups.md`

- [ ] **Step 1: Run** `pnpm exec vitest run tools/capabilities` (all pass), then `pnpm test`. Expect green; report the counts.
- [ ] **Step 2: Run all tiers:** `node tools/capabilities/run.mjs --tier cli`, `--tier desktop` and `--tier browser`. Allow up to 30 minutes in total.
- [ ] **Step 3: Check** that `MATRIX.md` shows today's date for all three tiers, and that `git status --short src-tauri tools/capabilities/spikes` is clean.
- [ ] **Step 4: Update the follow-ups doc** with every new `fail`, grouped by roadmap sub-project:
  - ARR → 1
  - MIX/CUE → 2
  - AUT → 3
  - EXP → 4
  - TUNE → 5
  - PERF → 6
  - SYNC/PLUG → 7
  - LANG → the language front end

  Also add the Surge XT install instructions.
- [ ] **Step 5: Commit** the results, MATRIX.md and the follow-ups doc with `chore(capabilities): full three-tier scoreboard`, then push `dev` to origin.
