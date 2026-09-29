#!/usr/bin/env node
// Runs capability probes for one tier and regenerates MATRIX.md.
// See tools/capabilities/README.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findChromium, launchChromium } from './lib/browser/chromium.mjs';
import { openPage, waitForRepl } from './lib/browser/cdp.mjs';
import { startStaticServer } from './lib/browser/server.mjs';
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
    if (!existsSync(probePath)) continue; // no result yet; fillMissing (after carry-forward) covers it
    console.log(`[${tier}] ${cell.id} ...`);
    const url = pathToFileURL(probePath).href;
    const log = (...args) => console.log(`  [${cell.id}]`, ...args);
    // import() happens inside runProbe so a probe module that fails to load (including its own
    // static imports) is recorded as a fail, not an uncaught exception that kills the whole run.
    results[cell.id] = await runProbe(
      async (c) => (await import(url)).probe(c),
      { tier, thresholds: cell.thresholds, repoRoot, tmpDir: tmpdir(), log },
    );
    console.log(`[${tier}] ${cell.id}: ${results[cell.id].status}`);
  }
  return results;
}

function notRunAll(cells, reason) {
  const results = {};
  for (const cell of cells) results[cell.id] = { status: 'not-run', metrics: {}, notes: { reason } };
  return results;
}

// Browser tier without --ingest: drives the production build in a headless Chromium tab over the
// DevTools protocol instead of reading a manually-produced results file.
async function runBrowserTier(tier, only) {
  const cells = cellsForTier(caps, tier).filter((c) => !only || c.id === only);
  const distPath = join(repoRoot, 'website', 'dist', 'index.html');
  if (!existsSync(distPath)) return notRunAll(cells, 'website/dist missing: run pnpm build');

  const executable = findChromium();
  if (!executable) return notRunAll(cells, 'no Chromium headless shell in ~/.cache/ms-playwright');

  const dist = { path: distPath, builtAt: statSync(distPath).mtime.toISOString() };
  const server = await startStaticServer(join(repoRoot, 'website', 'dist'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'caps-chromium-'));
  let chromium;
  try {
    chromium = await launchChromium(executable, userDataDir);
  } catch (err) {
    await server.close();
    return notRunAll(cells, `failed to launch Chromium: ${err.message}`);
  }

  const results = {};
  try {
    for (const cell of cells) {
      const probePath = join(here, 'probes', tier, `${cell.id}.mjs`);
      if (!existsSync(probePath)) continue; // no result yet; fillMissing (after carry-forward) covers it
      console.log(`[${tier}] ${cell.id} ...`);
      const url = pathToFileURL(probePath).href;
      const log = (...args) => console.log(`  [${cell.id}]`, ...args);
      let page;
      results[cell.id] = await runProbe(
        async (c) => {
          page = await openPage(chromium.port, `${server.url}/`);
          await waitForRepl(page);
          return (await import(url)).probe({ ...c, page, dist });
        },
        { tier, thresholds: cell.thresholds, repoRoot, tmpDir: tmpdir(), log },
      );
      if (page) page.close();
      console.log(`[${tier}] ${cell.id}: ${results[cell.id].status}`);
    }
  } finally {
    chromium.close();
    await server.close();
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

// Every cell of the tier that still has no result after merging in previous/new results.
function fillMissing(tier, results) {
  const filled = { ...results };
  for (const cell of cellsForTier(caps, tier)) {
    if (!filled[cell.id]) filled[cell.id] = { status: 'not-run', metrics: {}, notes: { reason: 'no probe yet' } };
  }
  return filled;
}

function newestResultFile(tier) {
  if (!existsSync(resultsDir)) return undefined;
  const files = readdirSync(resultsDir)
    .filter((f) => f.endsWith(`-${tier}.json`))
    .sort();
  return files.length ? join(resultsDir, files.at(-1)) : undefined;
}

function latestResults() {
  const byTier = {};
  for (const tier of TIERS) {
    const file = newestResultFile(tier);
    if (file) byTier[tier] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return byTier;
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function isDirty() {
  try {
    const out = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'tools/capabilities', 'packages', 'src-tauri'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return out.trim().length > 0;
  } catch {
    return undefined;
  }
}

// Stamps every newly produced result (probe run or ingest) with provenance: when, on what commit,
// against which thresholds, and how it was produced. Carried-forward results keep their own `run`.
function withProvenance(results, tier, source) {
  const thresholdsById = new Map(cellsForTier(caps, tier).map((c) => [c.id, c.thresholds]));
  const run = {
    ranAt: new Date().toISOString(),
    commit: currentCommit(),
    dirty: isDirty(),
    source,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  const out = {};
  for (const [id, result] of Object.entries(results)) {
    out[id] = { ...result, run: { ...run, thresholds: thresholdsById.get(id) ?? {} } };
  }
  return out;
}

if (!values['matrix-only']) {
  const { tier } = values;
  if (!TIERS.includes(tier)) {
    console.error(`--tier must be one of: ${TIERS.join(', ')}`);
    process.exit(2);
  }
  if (values.only && !cellsForTier(caps, tier).some((c) => c.id === values.only)) {
    console.error(`--only ${values.only} is not a ${tier} cell`);
    process.exit(2);
  }
  const source = values.ingest ? 'ingest' : 'probe';
  const results = values.ingest
    ? ingest(tier, values.ingest)
    : tier === 'browser'
      ? await runBrowserTier(tier, values.only)
      : await runTier(tier, values.only);
  const provenanced = withProvenance(results, tier, source);
  const date = new Date().toISOString().slice(0, 10);
  const file = join(resultsDir, `${date}-${tier}.json`);
  mkdirSync(resultsDir, { recursive: true });
  // Carry forward from the newest existing result file for this tier (any date), not just today's.
  const prevFile = newestResultFile(tier);
  const previous = prevFile ? JSON.parse(readFileSync(prevFile, 'utf8')).results : {};
  const record = {
    tier,
    date,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    results: fillMissing(tier, { ...previous, ...provenanced }),
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${file}`);
}

writeFileSync(join(here, 'MATRIX.md'), renderMatrix(caps, latestResults()));
console.log(`wrote ${join(here, 'MATRIX.md')}`);
