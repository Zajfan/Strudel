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
