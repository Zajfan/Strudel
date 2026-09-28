# Capability Matrix Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable capability scoreboard (`tools/capabilities/`) and its first four probes: CLI BUILD-0, CLI EXP-1, CLI PERF-1, and Desktop BUILD-0.

**Architecture:** `capabilities.json` defines each capability, with its per-tier level (`req`/`opt`/`n/a`) and per-tier thresholds. Each probe is a module exporting `async probe(ctx)`. `run.mjs` runs the probes for one tier and normalizes their results through a strict contract. It writes `results/<date>-<tier>.json` and regenerates `MATRIX.md`, including the NexusLang port review. CLI audio probes render offline through supradough's `Dough` class, which is pure JS with no imports.

**Tech Stack:** Node 22 (`.nvmrc`), pnpm 10.33 (bundled with Node 22.21.1 under nvm), Vitest 3, `@strudel/core` / `@strudel/mini` / `@strudel/tonal` (workspace), `packages/supradough/dough.mjs`, and Rust `cargo` for the desktop probe.

**Spec:** `docs/superpowers/specs/2026-09-28-capability-matrix-design.md`

## Global Constraints

- Statuses are exactly `pass | fail | wall | not-run`; `not-run` never counts as a pass.
- A probe that observes zero events or zero signal reports `fail`, never `pass`.
- `wall` requires `notes.evidence`; without it, the runner downgrades the result to `fail`.
- A probe that throws is recorded as `fail`, with the error in `notes.error`.
- Thresholds live only in `capabilities.json`, never inside probes. A threshold changes only in a commit that also edits the spec.
- A port review is triggered only by a `wall` in a `req` cell of the `desktop` or `cli` tier.
- Walls in the rows `ARR`, `LANG`, `TUNE` → kind `front-end`; walls in any other row → kind `engine` (this clarifies the spec, which lists only part of the engine rows).
- `tools/capabilities/` is tooling, not application code. Do not modify anything under `packages/`.
- Do not push to `upstream` (Codeberg); its push URL is disabled. Pushing to `origin` (GitHub fork) is allowed.
- Uncommitted baseline files (`docs/development-baseline.md`, `tools/baseline/`, `packages/core/test/cyclist.test.mjs`, `test/runtime.mjs`, `packages/mini/bench/mini.bench.mjs`, root `package.json`, `.npmrc`) are the user's work in progress. Never stage them in this plan's commits; always `git add` explicit paths.
- Use Node 22 for every command: prefix with `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" &&`.

---

### Task 1: Repair the workspace so dependencies install

The working tree has corrupted edits. All 25 `packages/*/package.json` files had `"workspace:*"` replaced by `"*` with no closing quote (invalid JSON; the diff contains nothing else). `pnpm-workspace.yaml` lost its `onlyBuiltDependencies:` key line, so `esbuild`, `nx` and `sharp` became workspace globs, and it gained an `allowBuilds` block with placeholder values. `pnpm-lock.yaml` was rewritten by an unfrozen install. The root `package.json` change (the test script without `--version`) is intentional and stays.

**Files:**
- Restore: `packages/*/package.json` (25 files), `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- Keep untouched: `package.json`, `.npmrc`, all untracked baseline files

**Interfaces:**
- Consumes: nothing
- Produces: installed `node_modules`; a green test suite that later tasks rely on

- [ ] **Step 1: Confirm the package.json diffs contain only the corruption**

Run:
```bash
git diff -U0 -- 'packages/*/package.json' | grep '^[-+] ' | sed -E 's/"[^"]+": //' | sort | uniq -c
```
Expected: exactly four kinds of lines: `- "workspace:*",`, `+ "*,`, `- "workspace:*"`, `+ "*`. If anything else appears, STOP and report it to the user instead of restoring.

- [ ] **Step 2: Restore the corrupted files from HEAD**

```bash
git restore -- $(git diff --name-only -- 'packages/*/package.json') pnpm-workspace.yaml pnpm-lock.yaml
for f in package.json packages/*/package.json; do node -e "JSON.parse(require('fs').readFileSync('$f'))" || echo "INVALID: $f"; done
```
Expected: no `INVALID` lines.

- [ ] **Step 3: Install with the frozen lockfile under Node 22**

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && node --version && pnpm --version && pnpm install --frozen-lockfile
```
Expected: `v22.21.1`, `10.33.0`, and install success. `git status --short pnpm-lock.yaml pnpm-workspace.yaml` must print nothing afterwards. If the install fails, STOP and report the error output verbatim.

- [ ] **Step 4: Run the full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && pnpm test 2>&1 | tail -15
```
Expected: every test file passes. The baseline recorded 22 files and 1,057 tests. Record the actual counts in the task report; do not update snapshots.

- [ ] **Step 5: No commit**

The restored files equal HEAD, so there is nothing to commit. Report `git status --short`.

---

### Task 2: Probe result contract

**Files:**
- Create: `tools/capabilities/lib/result.mjs`
- Test: `tools/capabilities/test/result.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `STATUSES: string[]`, equal to `['pass', 'fail', 'wall', 'not-run']`
  - `normalizeResult(raw: any) → { status, metrics: object, notes: object }`
  - `runProbe(probe: (ctx) => Promise<any>, ctx: object) → Promise<{ status, metrics, notes }>`

- [ ] **Step 1: Write the failing tests**

`tools/capabilities/test/result.test.mjs`:
```js
import { describe, expect, it } from 'vitest';
import { normalizeResult, runProbe, STATUSES } from '../lib/result.mjs';

describe('normalizeResult', () => {
  it('keeps a valid pass', () => {
    const r = normalizeResult({ status: 'pass', metrics: { x: 1 }, notes: {} });
    expect(r).toEqual({ status: 'pass', metrics: { x: 1 }, notes: {} });
  });
  it('fills missing metrics and notes', () => {
    expect(normalizeResult({ status: 'not-run' })).toEqual({ status: 'not-run', metrics: {}, notes: {} });
  });
  it('turns a non-object into fail', () => {
    const r = normalizeResult(undefined);
    expect(r.status).toBe('fail');
    expect(r.notes.error).toMatch(/no result object/);
  });
  it('turns an unknown status into fail', () => {
    const r = normalizeResult({ status: 'ok' });
    expect(r.status).toBe('fail');
    expect(r.notes.error).toMatch(/invalid status: ok/);
  });
  it('downgrades a wall without evidence to fail', () => {
    const r = normalizeResult({ status: 'wall', notes: {} });
    expect(r.status).toBe('fail');
    expect(r.notes.error).toMatch(/evidence/);
  });
  it('keeps a wall with evidence', () => {
    const r = normalizeResult({ status: 'wall', notes: { evidence: 'no VST3 in browsers' } });
    expect(r.status).toBe('wall');
  });
  it('exports exactly four statuses', () => {
    expect(STATUSES).toEqual(['pass', 'fail', 'wall', 'not-run']);
  });
});

describe('runProbe', () => {
  it('records a throwing probe as fail with the error', async () => {
    const r = await runProbe(async () => {
      throw new Error('boom');
    }, {});
    expect(r.status).toBe('fail');
    expect(r.notes.error).toMatch(/boom/);
  });
  it('passes ctx through and normalizes the result', async () => {
    const r = await runProbe(async (ctx) => ({ status: 'pass', metrics: { tier: ctx.tier } }), { tier: 'cli' });
    expect(r).toEqual({ status: 'pass', metrics: { tier: 'cli' }, notes: {} });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && pnpm exec vitest run tools/capabilities/test/result.test.mjs`
Expected: FAIL, because `../lib/result.mjs` cannot be resolved.

- [ ] **Step 3: Implement**

`tools/capabilities/lib/result.mjs`:
```js
// Probe result contract. See docs/superpowers/specs/2026-09-28-capability-matrix-design.md
export const STATUSES = ['pass', 'fail', 'wall', 'not-run'];

export function normalizeResult(raw) {
  if (raw == null || typeof raw !== 'object') {
    return { status: 'fail', metrics: {}, notes: { error: 'probe returned no result object' } };
  }
  const metrics = raw.metrics ?? {};
  const notes = raw.notes ?? {};
  if (!STATUSES.includes(raw.status)) {
    return { status: 'fail', metrics, notes: { ...notes, error: `invalid status: ${raw.status}` } };
  }
  if (raw.status === 'wall' && !notes.evidence) {
    return { status: 'fail', metrics, notes: { ...notes, error: 'wall reported without notes.evidence' } };
  }
  return { status: raw.status, metrics, notes };
}

export async function runProbe(probe, ctx) {
  try {
    return normalizeResult(await probe(ctx));
  } catch (err) {
    return { status: 'fail', metrics: {}, notes: { error: String(err?.stack ?? err) } };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && pnpm exec vitest run tools/capabilities/test/result.test.mjs`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/capabilities/lib/result.mjs tools/capabilities/test/result.test.mjs
git commit -m "feat(capabilities): probe result contract"
```

---

### Task 3: Matrix definition, validation, and scoreboard rendering

**Files:**
- Create: `tools/capabilities/capabilities.json`
- Create: `tools/capabilities/lib/matrix.mjs`
- Test: `tools/capabilities/test/matrix.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `TIERS = ['browser', 'desktop', 'cli']`, `LEVELS = ['req', 'opt', 'n/a']`
  - `validateCapabilities(caps) → string[]` (error messages; empty means valid)
  - `loadCapabilities(path: string) → caps` (throws on invalid)
  - `cellsForTier(caps, tier) → { id, level, thresholds }[]` (excludes `n/a`)
  - `portReview(caps, resultsByTier) → { id, tier, kind: 'front-end' | 'engine', evidence }[]`
  - `renderMatrix(caps, resultsByTier) → string` (Markdown)
  - `resultsByTier` shape: `{ [tier]: { date: string, results: { [id]: { status, metrics, notes } } } }`
  - A probe may set `metrics.headline` (short string); the matrix shows it in the cell.

- [ ] **Step 1: Write the failing tests**

`tools/capabilities/test/matrix.test.mjs`:
```js
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { cellsForTier, loadCapabilities, portReview, renderMatrix, validateCapabilities } from '../lib/matrix.mjs';

const tiers = (browser, desktop, cli) => ({ browser, desktop, cli });
const caps = {
  capabilities: [
    { id: 'ARR-1', name: 'Long-form song', criterion: 'c', tiers: tiers('req', 'req', 'req') },
    { id: 'PLUG-1', name: 'Plugin', criterion: 'c', tiers: tiers('n/a', 'req', 'opt'), thresholds: { desktop: { t: 1 } } },
  ],
};

describe('validateCapabilities', () => {
  it('accepts a valid matrix', () => {
    expect(validateCapabilities(caps)).toEqual([]);
  });
  it('reports bad ids, duplicates, missing criteria and bad levels', () => {
    const errors = validateCapabilities({
      capabilities: [
        { id: 'bad', name: 'x', criterion: 'c', tiers: tiers('req', 'req', 'req') },
        { id: 'A-1', name: 'x', criterion: '', tiers: tiers('req', 'maybe', 'req') },
        { id: 'A-1', name: 'x', criterion: 'c', tiers: tiers('req', 'req', 'req') },
      ],
    });
    expect(errors).toEqual([
      'bad id: bad',
      'A-1: missing criterion',
      'A-1: bad level for desktop: maybe',
      'duplicate id: A-1',
    ]);
  });
  it('rejects an empty matrix', () => {
    expect(validateCapabilities({ capabilities: [] })).toEqual(['no capabilities']);
  });
});

describe('cellsForTier', () => {
  it('skips n/a cells and attaches tier thresholds', () => {
    expect(cellsForTier(caps, 'browser')).toEqual([{ id: 'ARR-1', level: 'req', thresholds: {} }]);
    expect(cellsForTier(caps, 'desktop')).toEqual([
      { id: 'ARR-1', level: 'req', thresholds: {} },
      { id: 'PLUG-1', level: 'req', thresholds: { t: 1 } },
    ]);
  });
});

describe('portReview', () => {
  const wall = (evidence) => ({ status: 'wall', metrics: {}, notes: { evidence } });
  it('flags walls in required desktop/cli cells and classifies them', () => {
    const review = portReview(caps, {
      desktop: { date: 'd', results: { 'PLUG-1': wall('no host') } },
      cli: { date: 'd', results: { 'ARR-1': wall('syntax limit') } },
    });
    expect(review).toEqual([
      { id: 'PLUG-1', tier: 'desktop', kind: 'engine', evidence: 'no host' },
      { id: 'ARR-1', tier: 'cli', kind: 'front-end', evidence: 'syntax limit' },
    ]);
  });
  it('ignores browser walls and walls in optional cells', () => {
    const review = portReview(caps, {
      browser: { date: 'd', results: { 'ARR-1': wall('x') } },
      cli: { date: 'd', results: { 'PLUG-1': wall('x') } },
    });
    expect(review).toEqual([]);
  });
});

describe('renderMatrix', () => {
  it('renders levels, statuses, headlines, never-run tiers and the port review', () => {
    const md = renderMatrix(caps, {
      cli: { date: '2026-09-28', results: { 'ARR-1': { status: 'pass', metrics: { headline: '64 bars' }, notes: {} } } },
    });
    expect(md).toContain('| cli | 2026-09-28 |');
    expect(md).toContain('| browser | never run |');
    expect(md).toContain('| ARR-1 | Long-form song | req · not-run | req · not-run | req · pass (64 bars) |');
    expect(md).toContain('| PLUG-1 | Plugin | n/a | req · not-run | opt · not-run |');
    expect(md).toContain('No walls in required Desktop or CLI cells.');
  });
});

describe('capabilities.json', () => {
  it('is valid and contains the spec rows', () => {
    const real = loadCapabilities(fileURLToPath(new URL('../capabilities.json', import.meta.url)));
    expect(real.capabilities.map((c) => c.id)).toEqual([
      'ARR-1', 'MIX-1', 'AUT-1', 'EXP-1', 'EXP-2', 'PERF-1', 'LIVE-1',
      'CUE-1', 'PLUG-1', 'SYNC-1', 'TUNE-1', 'LANG-1', 'BUILD-0',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && pnpm exec vitest run tools/capabilities/test/matrix.test.mjs`
Expected: FAIL, because `../lib/matrix.mjs` cannot be resolved.

- [ ] **Step 3: Write `capabilities.json`**

The values are copied from the spec's "Initial matrix" table. Thresholds exist only where a probe in this plan reads them, plus the numeric ones already fixed by the spec.

`tools/capabilities/capabilities.json`:
```json
{
  "capabilities": [
    { "id": "ARR-1", "name": "Long-form song", "criterion": "64-bar, 8-section piece with a hard ending in one file; renders with the correct section boundaries", "tiers": { "browser": "req", "desktop": "req", "cli": "req" } },
    { "id": "MIX-1", "name": "Buses, send, sidechain", "criterion": "4 buses, one send, one ducked bus; ducking depth >= 6 dB measured on the output", "tiers": { "browser": "req", "desktop": "req", "cli": "req" }, "thresholds": { "browser": { "minDuckDb": 6 }, "desktop": { "minDuckDb": 6 }, "cli": { "minDuckDb": 6 } } },
    { "id": "AUT-1", "name": "Automation precision", "criterion": "Parameter ramp timing error < 1 ms at 48 kHz", "tiers": { "browser": "req", "desktop": "req", "cli": "req" }, "thresholds": { "browser": { "maxErrorMs": 1 }, "desktop": { "maxErrorMs": 1 }, "cli": { "maxErrorMs": 1 } } },
    { "id": "EXP-1", "name": "Offline render", "criterion": "Reference song renders to WAV: non-silent, correct length, byte-identical across two runs", "tiers": { "browser": "req", "desktop": "req", "cli": "req" }, "thresholds": { "cli": { "minRms": 0.001 } } },
    { "id": "EXP-2", "name": "Stems", "criterion": "One WAV per bus; the stems sum to the mix within -60 dBFS residual", "tiers": { "browser": "opt", "desktop": "req", "cli": "req" }, "thresholds": { "browser": { "maxResidualDbfs": -60 }, "desktop": { "maxResidualDbfs": -60 }, "cli": { "maxResidualDbfs": -60 } } },
    { "id": "PERF-1", "name": "Voice capacity", "criterion": "Sustained polyphony for 60 s with 0 late starts (Browser >= 64, Desktop >= 256 voices); CLI renders the reference song >= 4x real time", "tiers": { "browser": "req", "desktop": "req", "cli": "req" }, "thresholds": { "browser": { "minVoices": 64 }, "desktop": { "minVoices": 256 }, "cli": { "minRealtimeFactor": 4 } } },
    { "id": "LIVE-1", "name": "Safe live swap", "criterion": "A failing evaluation mid-playback causes no audio gap > 128 frames; the previous pattern continues", "tiers": { "browser": "req", "desktop": "req", "cli": "n/a" }, "thresholds": { "browser": { "maxGapFrames": 128 }, "desktop": { "maxGapFrames": 128 } } },
    { "id": "CUE-1", "name": "Headphone cue", "criterion": "A pattern can be routed to a second output device, inaudible on the main output", "tiers": { "browser": "opt", "desktop": "req", "cli": "n/a" } },
    { "id": "PLUG-1", "name": "Third-party plugin", "criterion": "Load a CLAP or VST3 instrument, play notes from a pattern, capture non-silent output", "tiers": { "browser": "n/a", "desktop": "req", "cli": "opt" } },
    { "id": "SYNC-1", "name": "External clock", "criterion": "MIDI clock-out jitter < 2 ms over 60 s", "tiers": { "browser": "opt", "desktop": "req", "cli": "opt" }, "thresholds": { "browser": { "maxJitterMs": 2 }, "desktop": { "maxJitterMs": 2 }, "cli": { "maxJitterMs": 2 } } },
    { "id": "TUNE-1", "name": "Microtonal", "criterion": "19-EDO and a just-intonation scale usable in pattern code; pitches within +-1 cent", "tiers": { "browser": "req", "desktop": "req", "cli": "req" }, "thresholds": { "browser": { "maxCents": 1 }, "desktop": { "maxCents": 1 }, "cli": { "maxCents": 1 } } },
    { "id": "LANG-1", "name": "Error quality", "criterion": "A syntax error and an unknown function each report the exact line and column", "tiers": { "browser": "req", "desktop": "req", "cli": "req" } },
    { "id": "BUILD-0", "name": "Tier builds", "criterion": "The tier builds from a clean checkout with the documented toolchain", "tiers": { "browser": "req", "desktop": "req", "cli": "req" }, "thresholds": { "desktop": { "timeoutMs": 1200000 } } }
  ]
}
```

- [ ] **Step 4: Implement `matrix.mjs`**

`tools/capabilities/lib/matrix.mjs`:
```js
// Capability matrix: definition, validation and the generated scoreboard.
import { readFileSync } from 'node:fs';

export const TIERS = ['browser', 'desktop', 'cli'];
export const LEVELS = ['req', 'opt', 'n/a'];
// Walls in these rows mean NexusLang as a new front end; any other row means the engine.
const FRONT_END_PREFIXES = ['ARR', 'LANG', 'TUNE'];
const PORT_TIERS = ['desktop', 'cli'];

export function validateCapabilities(caps) {
  const errors = [];
  const seen = new Set();
  for (const c of caps.capabilities ?? []) {
    if (!/^[A-Z]+-\d+$/.test(c.id)) errors.push(`bad id: ${c.id}`);
    if (seen.has(c.id)) errors.push(`duplicate id: ${c.id}`);
    seen.add(c.id);
    if (!c.criterion) errors.push(`${c.id}: missing criterion`);
    for (const tier of TIERS) {
      if (!LEVELS.includes(c.tiers?.[tier])) errors.push(`${c.id}: bad level for ${tier}: ${c.tiers?.[tier]}`);
    }
  }
  if (!seen.size) errors.push('no capabilities');
  return errors;
}

export function loadCapabilities(path) {
  const caps = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateCapabilities(caps);
  if (errors.length) throw new Error(`invalid ${path}:\n${errors.join('\n')}`);
  return caps;
}

export function cellsForTier(caps, tier) {
  return caps.capabilities
    .filter((c) => c.tiers[tier] !== 'n/a')
    .map((c) => ({ id: c.id, level: c.tiers[tier], thresholds: c.thresholds?.[tier] ?? {} }));
}

export function portReview(caps, resultsByTier) {
  const review = [];
  for (const tier of PORT_TIERS) {
    const results = resultsByTier[tier]?.results ?? {};
    for (const c of caps.capabilities) {
      const result = results[c.id];
      if (c.tiers[tier] !== 'req' || result?.status !== 'wall') continue;
      const kind = FRONT_END_PREFIXES.includes(c.id.split('-')[0]) ? 'front-end' : 'engine';
      review.push({ id: c.id, tier, kind, evidence: result.notes.evidence });
    }
  }
  return review;
}

function formatCell(level, result) {
  if (level === 'n/a') return 'n/a';
  const status = result?.status ?? 'not-run';
  const headline = result?.metrics?.headline;
  return `${level} · ${status}${headline ? ` (${headline})` : ''}`;
}

export function renderMatrix(caps, resultsByTier) {
  const lines = ['# Capability matrix', '', 'Generated by `tools/capabilities/run.mjs`. Do not edit by hand.', ''];
  lines.push('| Tier | Results from |', '|---|---|');
  for (const tier of TIERS) lines.push(`| ${tier} | ${resultsByTier[tier]?.date ?? 'never run'} |`);
  lines.push('', '| ID | Capability | Browser | Desktop | CLI |', '|---|---|---|---|---|');
  for (const c of caps.capabilities) {
    const cells = TIERS.map((tier) => formatCell(c.tiers[tier], resultsByTier[tier]?.results?.[c.id]));
    lines.push(`| ${c.id} | ${c.name} | ${cells.join(' | ')} |`);
  }
  lines.push('', '## Port review', '');
  const review = portReview(caps, resultsByTier);
  if (!review.length) lines.push('No walls in required Desktop or CLI cells.');
  for (const r of review) lines.push(`- **${r.id}** (${r.tier}, ${r.kind}): ${r.evidence}`);
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && pnpm exec vitest run tools/capabilities/test/matrix.test.mjs`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add tools/capabilities/capabilities.json tools/capabilities/lib/matrix.mjs tools/capabilities/test/matrix.test.mjs
git commit -m "feat(capabilities): matrix definition and scoreboard rendering"
```

---

### Task 4: Runner

**Files:**
- Create: `tools/capabilities/run.mjs`
- Create: `tools/capabilities/README.md`

**Interfaces:**
- Consumes: `loadCapabilities`, `cellsForTier`, `renderMatrix`, `TIERS` (Task 3); `normalizeResult`, `runProbe` (Task 2)
- Produces:
  - Probe files at `tools/capabilities/probes/<tier>/<ID>.mjs`, each exporting `async function probe(ctx)`
  - `ctx = { tier: string, thresholds: object, repoRoot: string, tmpDir: string, log: (...args) => void }`
  - Result file `tools/capabilities/results/<YYYY-MM-DD>-<tier>.json`, shaped `{ tier, date, node, platform, results: { [id]: result } }`; each run merges into the same day's file
  - `tools/capabilities/MATRIX.md`, regenerated on every run from the newest result file per tier
  - CLI: `node tools/capabilities/run.mjs --tier cli|desktop [--only ID]`, `--tier browser --ingest <file.json>`, `--matrix-only`

- [ ] **Step 1: Implement `run.mjs`**

`tools/capabilities/run.mjs`:
```js
#!/usr/bin/env node
// Runs capability probes for one tier and regenerates MATRIX.md.
// See tools/capabilities/README.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cellsForTier, loadCapabilities, renderMatrix, TIERS } from './lib/matrix.mjs';
import { normalizeResult, runProbe } from './lib/result.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const resultsDir = join(here, 'results');

const { values } = parseArgs({
  options: {
    tier: { type: 'string' },
    only: { type: 'string' },
    ingest: { type: 'string' },
    'matrix-only': { type: 'boolean' },
  },
});

const caps = loadCapabilities(join(here, 'capabilities.json'));

async function runTier(tier, only) {
  const results = {};
  for (const cell of cellsForTier(caps, tier)) {
    if (only && cell.id !== only) continue;
    const probePath = join(here, 'probes', tier, `${cell.id}.mjs`);
    if (!existsSync(probePath)) {
      results[cell.id] = { status: 'not-run', metrics: {}, notes: { reason: 'no probe yet' } };
      continue;
    }
    console.log(`[${tier}] ${cell.id} ...`);
    const { probe } = await import(pathToFileURL(probePath).href);
    const log = (...args) => console.log(`  [${cell.id}]`, ...args);
    results[cell.id] = await runProbe(probe, { tier, thresholds: cell.thresholds, repoRoot, tmpDir: tmpdir(), log });
    console.log(`[${tier}] ${cell.id}: ${results[cell.id].status}`);
  }
  return results;
}

function ingest(tier, file) {
  const known = new Set(cellsForTier(caps, tier).map((c) => c.id));
  const raw = JSON.parse(readFileSync(file, 'utf8')).results ?? {};
  const results = {};
  for (const [id, result] of Object.entries(raw)) {
    if (!known.has(id)) throw new Error(`${file}: ${id} is not a ${tier} cell`);
    results[id] = normalizeResult(result);
  }
  return results;
}

function latestResults() {
  const byTier = {};
  if (!existsSync(resultsDir)) return byTier;
  for (const tier of TIERS) {
    const files = readdirSync(resultsDir)
      .filter((f) => f.endsWith(`-${tier}.json`))
      .sort();
    if (files.length) byTier[tier] = JSON.parse(readFileSync(join(resultsDir, files.at(-1)), 'utf8'));
  }
  return byTier;
}

if (!values['matrix-only']) {
  const { tier } = values;
  if (!TIERS.includes(tier)) {
    console.error(`--tier must be one of: ${TIERS.join(', ')}`);
    process.exit(2);
  }
  if (tier === 'browser' && !values.ingest) {
    console.error('browser probes run in a page; pass --ingest <results.json>');
    process.exit(2);
  }
  const results = values.ingest ? ingest(tier, values.ingest) : await runTier(tier, values.only);
  const date = new Date().toISOString().slice(0, 10);
  const file = join(resultsDir, `${date}-${tier}.json`);
  mkdirSync(resultsDir, { recursive: true });
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).results : {};
  const record = {
    tier,
    date,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    results: { ...previous, ...results },
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${file}`);
}

writeFileSync(join(here, 'MATRIX.md'), renderMatrix(caps, latestResults()));
console.log(`wrote ${join(here, 'MATRIX.md')}`);
```

- [ ] **Step 2: Verify the no-probe run marks every cell `not-run`**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && node tools/capabilities/run.mjs --tier cli && grep -c '"not-run"' tools/capabilities/results/*-cli.json && grep 'LIVE-1' tools/capabilities/MATRIX.md
```
Expected: `11` (the 13 rows minus LIVE-1 and CUE-1, which are `n/a` for CLI); the LIVE-1 row reads `| LIVE-1 | Safe live swap | req · not-run | req · not-run | n/a |`.

- [ ] **Step 3: Verify argument errors and ingest validation**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
node tools/capabilities/run.mjs --tier nope; echo "exit=$?"
node tools/capabilities/run.mjs --tier browser; echo "exit=$?"
bad=$(mktemp --suffix=.json) && echo '{"results":{"PLUG-1":{"status":"pass"}}}' > "$bad"
node tools/capabilities/run.mjs --tier browser --ingest "$bad" 2>&1 | grep -o 'PLUG-1 is not a browser cell'; rm -f "$bad"
```
Expected: `exit=2`, `exit=2`, then `PLUG-1 is not a browser cell`.

- [ ] **Step 4: Delete the trial results**

Run: `rm -rf tools/capabilities/results tools/capabilities/MATRIX.md`
Real results are committed in Task 8.

- [ ] **Step 5: Write the README**

`tools/capabilities/README.md`:
````markdown
# Capability probes

Scoreboard for sub-project #0. Design:
`docs/superpowers/specs/2026-09-28-capability-matrix-design.md`.

Tooling only, not application code. Use Node 22.

```sh
node tools/capabilities/run.mjs --tier cli             # all CLI probes
node tools/capabilities/run.mjs --tier desktop --only BUILD-0
node tools/capabilities/run.mjs --tier browser --ingest results.json
node tools/capabilities/run.mjs --matrix-only          # regenerate MATRIX.md
```

Each run merges into `results/<date>-<tier>.json` and regenerates `MATRIX.md`
from the newest file per tier. Commit both: they are the evidence.

## Writing a probe

Create `probes/<tier>/<ID>.mjs`:

```js
export async function probe({ tier, thresholds, repoRoot, tmpDir, log }) {
  return { status: 'pass', metrics: { headline: 'short summary' }, notes: {} };
}
```

- Statuses: `pass`, `fail`, `wall`, `not-run`. `not-run` never counts as a pass.
- Zero events or zero signal is `fail`.
- `wall` needs `notes.evidence` naming the platform limit, or it becomes `fail`.
- Read limits from `thresholds` (from `capabilities.json`). Never hard-code them.
- Throwing is recorded as `fail`.

Browser probes run in a page, as in `tools/baseline/README.md`. Save their
output as `{ "results": { "<ID>": { status, metrics, notes } } }` and ingest it.
````

- [ ] **Step 6: Commit**

```bash
git add tools/capabilities/run.mjs tools/capabilities/README.md
git commit -m "feat(capabilities): probe runner and README"
```

---

### Task 5: Offline render helpers and the CLI BUILD-0 probe

`Dough` (in `packages/supradough/dough.mjs`, no imports) renders one sample per `update()` call into `dough.out[0|1]`. Each event needs `value._begin` and `value._duration` in **seconds**. Following `packages/supradough/dough-export.mjs`, the pattern is slowed by `1 / cps`, so one cycle equals one second before it is queried. supradough's oscillators read a module-level `SAMPLE_RATE`, which is 48000 in Node (`dough.mjs:4`) whatever is passed to `new Dough(...)`. Always render at 48000; any other rate plays at the wrong pitch.

**Files:**
- Create: `tools/capabilities/lib/audio.mjs`
- Create: `tools/capabilities/lib/render.mjs`
- Create: `tools/capabilities/probes/cli/BUILD-0.mjs`
- Test: `tools/capabilities/test/audio.test.mjs`
- Test: `tools/capabilities/test/render.test.mjs`

**Interfaces:**
- Consumes: `Dough` from `packages/supradough/dough.mjs`; `note` from `@strudel/core`
- Produces:
  - `rms(samples: Float32Array) → number`
  - `firstByteDifference(a: Float32Array, b: Float32Array) → number` (−1 if bit-identical; 0 if the lengths differ; otherwise the first differing index)
  - `renderPattern(pattern, { cps = 0.5, cycles, tail = 1, sampleRate = 48000 }) → { left, right, sampleRate, eventCount, audioSeconds, renderSeconds }`

- [ ] **Step 1: Write the failing tests**

`tools/capabilities/test/audio.test.mjs`:
```js
import { describe, expect, it } from 'vitest';
import { firstByteDifference, rms } from '../lib/audio.mjs';

describe('rms', () => {
  it('is 0 for silence and 1 for a full-scale square', () => {
    expect(rms(new Float32Array(8))).toBe(0);
    expect(rms(Float32Array.from([1, -1, 1, -1]))).toBe(1);
  });
  it('is 0 for an empty buffer', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe('firstByteDifference', () => {
  it('returns -1 for identical buffers', () => {
    expect(firstByteDifference(Float32Array.from([0.1, 0.2]), Float32Array.from([0.1, 0.2]))).toBe(-1);
  });
  it('returns the first differing index', () => {
    expect(firstByteDifference(Float32Array.from([0.1, 0.2, 0.3]), Float32Array.from([0.1, 0.25, 0.3]))).toBe(1);
  });
  it('distinguishes 0 from -0', () => {
    expect(firstByteDifference(Float32Array.from([0]), Float32Array.from([-0]))).toBe(0);
  });
  it('returns 0 when lengths differ', () => {
    expect(firstByteDifference(new Float32Array(2), new Float32Array(3))).toBe(0);
  });
});
```

`tools/capabilities/test/render.test.mjs`:
```js
import { describe, expect, it } from 'vitest';
import { note, sequence, silence } from '@strudel/core';
import { renderPattern } from '../lib/render.mjs';
import { rms } from '../lib/audio.mjs';

describe('renderPattern', () => {
  it('renders two sine notes to a non-silent buffer of the expected length', () => {
    const out = renderPattern(note(sequence(60, 64)).s('sine'), { cps: 1, cycles: 1, tail: 0.5 });
    expect(out.eventCount).toBe(2);
    expect(out.left.length).toBe(72000);
    expect(out.right.length).toBe(72000);
    expect(out.audioSeconds).toBe(1.5);
    expect(rms(out.left)).toBeGreaterThan(0.001);
  });
  it('renders silence and zero events for a silent pattern', () => {
    const out = renderPattern(silence, { cps: 1, cycles: 1, tail: 0 });
    expect(out.eventCount).toBe(0);
    expect(rms(out.left)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && pnpm exec vitest run tools/capabilities/test/audio.test.mjs tools/capabilities/test/render.test.mjs`
Expected: FAIL, because `../lib/audio.mjs` and `../lib/render.mjs` cannot be resolved.

- [ ] **Step 3: Implement the helpers**

`tools/capabilities/lib/audio.mjs`:
```js
// Measurements on rendered sample buffers.
export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// Compares bit patterns, so -0 vs 0 and differing NaN payloads count as differences.
export function firstByteDifference(a, b) {
  if (a.length !== b.length) return 0;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return i;
  }
  return -1;
}
```

`tools/capabilities/lib/render.mjs`:
```js
// Offline rendering through supradough, mirroring packages/supradough/dough-export.mjs.
import { Dough } from '../../../packages/supradough/dough.mjs';

export function renderPattern(pattern, { cps = 0.5, cycles, tail = 1, sampleRate = 48000 }) {
  // dough's oscillators assume 48000 in Node (module-level SAMPLE_RATE in dough.mjs)
  if (sampleRate !== 48000) throw new Error(`supradough renders at 48000 Hz in Node, got ${sampleRate}`);
  // slow by 1/cps so that one queried unit is one second, as dough expects
  const songSeconds = cycles / cps;
  const haps = pattern
    .slow(1 / cps)
    .queryArc(0, songSeconds)
    .filter((hap) => hap.hasOnset());
  const dough = new Dough(sampleRate);
  for (const hap of haps) {
    dough.scheduleSpawn({ ...hap.value, _begin: Number(hap.whole.begin), _duration: Number(hap.duration) });
  }
  const length = Math.ceil((songSeconds + tail) * sampleRate);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const start = performance.now();
  for (let i = 0; i < length; i++) {
    dough.update();
    left[i] = dough.out[0];
    right[i] = dough.out[1];
  }
  const renderSeconds = (performance.now() - start) / 1000;
  return { left, right, sampleRate, eventCount: haps.length, audioSeconds: length / sampleRate, renderSeconds };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && pnpm exec vitest run tools/capabilities/test/audio.test.mjs tools/capabilities/test/render.test.mjs`
Expected: 8 passed. If the first render test reports `rms` of 0, check that the `Dough` voice received `s: 'sine'`: log `haps[0].value`. Do not change the assertion.

- [ ] **Step 5: Write the CLI BUILD-0 probe**

For the CLI tier, "builds" means the engine and the pattern language load in plain Node and produce sound.

`tools/capabilities/probes/cli/BUILD-0.mjs`:
```js
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
```

- [ ] **Step 6: Run it**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && node tools/capabilities/run.mjs --tier cli --only BUILD-0`
Expected: `[cli] BUILD-0: pass`. If it is `fail`, read `notes.error` in the results file and report it; a real failure is a finding, not something to work around.

- [ ] **Step 7: Commit (code only; results are committed in Task 8)**

```bash
rm -rf tools/capabilities/results tools/capabilities/MATRIX.md
git add tools/capabilities/lib/audio.mjs tools/capabilities/lib/render.mjs tools/capabilities/probes/cli/BUILD-0.mjs tools/capabilities/test/audio.test.mjs tools/capabilities/test/render.test.mjs
git commit -m "feat(capabilities): offline render helpers and CLI BUILD-0 probe"
```

---

### Task 6: Reference song, CLI EXP-1 and CLI PERF-1

The reference song is the pattern from `packages/supradough/dough-export.mjs`: synth voices, noise, delay and chords, with no samples, so no network is needed. It uses global pattern functions, so it is built after `evalScope` and `miniAllStrings()`, exactly like the proof of concept. supradough's noise oscillators and supersaw use `Math.random()` (`dough.mjs:103, 196-228`), so EXP-1 is **expected to fail on determinism**. That is a genuine finding for sub-project 4. Do not seed or patch `Math.random` in the probe.

**Files:**
- Create: `tools/capabilities/lib/reference-song.mjs`
- Create: `tools/capabilities/probes/cli/EXP-1.mjs`
- Create: `tools/capabilities/probes/cli/PERF-1.mjs`

**Interfaces:**
- Consumes: `renderPattern`, `rms`, `firstByteDifference` (Task 5)
- Produces:
  - `REFERENCE = { cps: 0.5, cycles: 32, tail: 1, sampleRate: 48000 }` (65 s of audio)
  - `referenceSong() → Promise<Pattern>`

- [ ] **Step 1: Write the reference song**

`tools/capabilities/lib/reference-song.mjs`:
```js
// Reference song for render probes: the pattern from packages/supradough/dough-export.mjs,
// synth-only so it needs no network. Builds with global pattern functions after evalScope.
/* global note, s, chord, sine, press, add, ply, rev */
import { evalScope } from '@strudel/core';
import { miniAllStrings } from '@strudel/mini';

export const REFERENCE = { cps: 0.5, cycles: 32, tail: 1, sampleRate: 48000 };

let loaded;

export async function referenceSong() {
  loaded ??= evalScope(import('@strudel/core'), import('@strudel/mini'), import('@strudel/tonal')).then(() =>
    miniAllStrings(),
  );
  await loaded;
  return note('c,eb,g,<bb c4 d4 eb4>')
    .s('sine')
    .press()
    .add(note(24))
    .fmi(3)
    .fmh(5.01)
    .dec(0.4)
    .delay('.6:<.12 .22>:.8')
    .jux(press)
    .rarely(add(note('12')))
    .lpf(400)
    .lpq(0.2)
    .lpd(0.4)
    .lpenv(3)
    .fmdecay(0.4)
    .fmenv(1)
    .postgain(0.6)
    .stack(s('<pink white>*8').dec(0.07).rarely(ply('2')).delay(0.5).hpf(sine.range(200, 2000).slow(4)).hpq(0.2))
    .stack(
      s('[- white@3]*2')
        .dec(0.4)
        .hpf('<2000!3 <4000 8000>>*4')
        .hpq(0.6)
        .ply('<1 2>*4')
        .postgain(0.5)
        .delay(0.5)
        .jux(rev)
        .lpf(5000),
    )
    .stack(
      note('<c2 - [- f1] ->*2')
        .s('square')
        .lpf(sine.range(100, 300).slow(4))
        .lpe(1)
        .segment(8)
        .lpd(0.3)
        .lpq(0.2)
        .dec(0.2)
        .speed('<1 2>')
        .ply('<1 2>')
        .postgain(1),
    )
    .stack(
      chord('<Cm Cm7 Cm9 Cm11 Fm Fm7 Fm9 Fm11>')
        .voicing()
        .s('<sine>')
        .clip(1)
        .rel(0.4)
        .vib('4:.2')
        .gain(0.7)
        .hpf(1200)
        .fm(0.5)
        .att(1)
        .lpa(0.5)
        .lpf(200)
        .lpenv(4)
        .chorus(0.8),
    );
}
```

- [ ] **Step 2: Smoke-test the song**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && node -e "
const { referenceSong } = await import('./tools/capabilities/lib/reference-song.mjs');
const pat = await referenceSong();
console.log('events in 4 cycles:', pat.queryArc(0, 4).filter((h) => h.hasOnset()).length);
" --input-type=module
```
Expected: a positive event count and no exception. If a function is reported as undefined, add the package that registers it to the `evalScope` call and report which one it was.

- [ ] **Step 3: Write the EXP-1 probe**

`tools/capabilities/probes/cli/EXP-1.mjs`:
```js
// EXP-1 (CLI): the reference song renders non-silent, at the right length, bit-identical twice.
import { firstByteDifference, rms } from '../../lib/audio.mjs';
import { REFERENCE, referenceSong } from '../../lib/reference-song.mjs';
import { renderPattern } from '../../lib/render.mjs';

export async function probe({ thresholds, log }) {
  const song = await referenceSong();
  log('render 1/2');
  const a = renderPattern(song, REFERENCE);
  log('render 2/2');
  const b = renderPattern(song, REFERENCE);
  const expectedLength = Math.ceil((REFERENCE.cycles / REFERENCE.cps + REFERENCE.tail) * REFERENCE.sampleRate);
  const diffLeft = firstByteDifference(a.left, b.left);
  const diffRight = firstByteDifference(a.right, b.right);
  const level = rms(a.left);
  const metrics = {
    events: a.eventCount,
    rms: level,
    lengthSamples: a.left.length,
    expectedLength,
    firstDifferenceLeft: diffLeft,
    firstDifferenceRight: diffRight,
  };
  const fail = (error, headline) => ({ status: 'fail', metrics: { ...metrics, headline }, notes: { error } });
  if (a.eventCount === 0) return fail('no events rendered', 'no events');
  if (level < thresholds.minRms) return fail(`rms ${level} below ${thresholds.minRms}`, 'silent');
  if (a.left.length !== expectedLength) return fail(`length ${a.left.length} != ${expectedLength}`, 'wrong length');
  if (diffLeft !== -1 || diffRight !== -1) {
    const first = diffLeft === -1 ? diffRight : diffRight === -1 ? diffLeft : Math.min(diffLeft, diffRight);
    return fail(
      `renders differ from sample ${first} (${(first / REFERENCE.sampleRate).toFixed(3)} s). Suspect: Math.random() in supradough noise/supersaw oscillators`,
      'non-deterministic',
    );
  }
  return { status: 'pass', metrics: { ...metrics, headline: `${a.audioSeconds} s, deterministic` }, notes: {} };
}
```

- [ ] **Step 4: Write the PERF-1 probe**

`tools/capabilities/probes/cli/PERF-1.mjs`:
```js
// PERF-1 (CLI): the reference song renders at least minRealtimeFactor times faster than real time.
import { rms } from '../../lib/audio.mjs';
import { REFERENCE, referenceSong } from '../../lib/reference-song.mjs';
import { renderPattern } from '../../lib/render.mjs';

export async function probe({ thresholds }) {
  const song = await referenceSong();
  const out = renderPattern(song, REFERENCE);
  const factor = out.audioSeconds / out.renderSeconds;
  const metrics = {
    events: out.eventCount,
    audioSeconds: out.audioSeconds,
    renderSeconds: out.renderSeconds,
    realtimeFactor: factor,
    headline: `${factor.toFixed(1)}x real time`,
  };
  if (out.eventCount === 0 || rms(out.left) === 0) {
    return { status: 'fail', metrics, notes: { error: 'no events or silent render; speed is meaningless' } };
  }
  if (factor < thresholds.minRealtimeFactor) {
    return { status: 'fail', metrics, notes: { error: `${factor.toFixed(2)}x < ${thresholds.minRealtimeFactor}x` } };
  }
  return { status: 'pass', metrics, notes: {} };
}
```

- [ ] **Step 5: Run both probes**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && node tools/capabilities/run.mjs --tier cli --only EXP-1 && node tools/capabilities/run.mjs --tier cli --only PERF-1`
Expected: each prints a status line. EXP-1 most likely reports `fail` with `non-deterministic`, and that is the finding. PERF-1 reports its `realtimeFactor`. Record both statuses and headlines in the task report exactly as printed.

- [ ] **Step 6: Commit (code only)**

```bash
rm -rf tools/capabilities/results tools/capabilities/MATRIX.md
git add tools/capabilities/lib/reference-song.mjs tools/capabilities/probes/cli/EXP-1.mjs tools/capabilities/probes/cli/PERF-1.mjs
git commit -m "feat(capabilities): reference song, CLI EXP-1 and PERF-1 probes"
```

---

### Task 7: Desktop BUILD-0 probe

Known lead: `src-tauri/Cargo.toml` pins `tauri = "1.4.0"` next to `tauri-plugin-clipboard-manager = "2"`, a Tauri v2 plugin. The probe reports what `cargo check` says; it does not fix anything. The first run downloads crates and may take several minutes. Missing system libraries (e.g. `webkit2gtk`) also count as `fail`, with the log tail as evidence. They are recorded, not worked around.

**Files:**
- Create: `tools/capabilities/probes/desktop/BUILD-0.mjs`

**Interfaces:**
- Consumes: `ctx.repoRoot`, `ctx.thresholds.timeoutMs` (1,200,000)
- Produces: a result with `metrics.exitCode`, `metrics.seconds`, and `notes.logTail` (last 30 lines of stderr)

- [ ] **Step 1: Write the probe**

`tools/capabilities/probes/desktop/BUILD-0.mjs`:
```js
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
    return { status: 'fail', metrics: { ...metrics, headline: 'timed out' }, notes: { error: String(run.error), logTail } };
  }
  if (run.status !== 0) {
    return { status: 'fail', metrics: { ...metrics, headline: 'cargo check failed' }, notes: { logTail } };
  }
  return { status: 'pass', metrics: { ...metrics, headline: `cargo check ${seconds} s` }, notes: {} };
}
```

- [ ] **Step 2: Run it**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && node tools/capabilities/run.mjs --tier desktop --only BUILD-0`
Timeout for this command: 20 minutes.
Expected: a status line. If it is `fail`, quote `notes.logTail` from the results file in the task report and name the first `error[...]` line.

- [ ] **Step 3: Commit (code only)**

```bash
rm -rf tools/capabilities/results tools/capabilities/MATRIX.md
git add tools/capabilities/probes/desktop/BUILD-0.mjs
git commit -m "feat(capabilities): desktop BUILD-0 probe"
```

`src-tauri/target/` is created by cargo. Verify it is ignored with `git status --short src-tauri`; if it shows up, do not stage it and report it.

---

### Task 8: First full run, recorded evidence

**Files:**
- Create (generated): `tools/capabilities/results/<date>-cli.json`, `tools/capabilities/results/<date>-desktop.json`, `tools/capabilities/MATRIX.md`

**Interfaces:**
- Consumes: everything above
- Produces: the committed first scoreboard

- [ ] **Step 1: Run the whole capability test set and the full suite**

Run: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && pnpm exec vitest run tools/capabilities && pnpm test 2>&1 | tail -8`
Expected: 25 capability tests passed (9 + 8 + 6 + 2), and the full suite is green with the counts from Task 1 plus 25.

- [ ] **Step 2: Run both tiers**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" && node tools/capabilities/run.mjs --tier cli && node tools/capabilities/run.mjs --tier desktop
```
Timeout: 25 minutes.
Expected: CLI runs BUILD-0, EXP-1 and PERF-1, and marks the other 8 cells `not-run`. Desktop runs BUILD-0 and marks the rest `not-run`.

- [ ] **Step 3: Inspect the scoreboard**

Run: `cat tools/capabilities/MATRIX.md`
Check: the `cli` and `desktop` dates are today; `browser` says `never run`; the port review says `No walls in required Desktop or CLI cells.` (none of these probes can report `wall`).

- [ ] **Step 4: Commit the evidence and push the branch**

```bash
git add tools/capabilities/results tools/capabilities/MATRIX.md
git commit -m "chore(capabilities): first CLI and desktop scoreboard"
git push origin capability-matrix
```

- [ ] **Step 5: Report**

Paste the `MATRIX.md` table into the final report, and state for each run probe its status, its headline, and (for failures) the one-line reason. List the remaining probes for the next plan: AUT-1, MIX-1, EXP-2, TUNE-1, LANG-1, ARR-1 (CLI); PLUG-1 spike (desktop); PERF-1, AUT-1, LIVE-1 (browser).
