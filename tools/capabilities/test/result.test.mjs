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
