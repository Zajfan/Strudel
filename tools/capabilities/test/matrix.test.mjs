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
