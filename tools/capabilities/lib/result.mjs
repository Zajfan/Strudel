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
