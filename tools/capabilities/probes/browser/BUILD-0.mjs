// BUILD-0 (browser): the production build is current, loads, the REPL starts, and a pattern
// evaluates without error and actually schedules audio (a pattern that "evaluates" but triggers
// nothing is not a pass). The probe does not rebuild: it requires website/dist to be newer than the
// newest commit touching packages/ or website/, so a stale dist cannot pass.
export async function probe({ page, dist }) {
  const result = await page.evaluate(async () => {
    const proto = AudioScheduledSourceNode.prototype;
    const originalStart = proto.start;
    let starts = 0;
    proto.start = function (...args) {
      starts++;
      return originalStart.apply(this, args);
    };
    const m = window.strudelMirror;
    try {
      m.setCode('note("c4").s("sine").gain(0.01)');
      await m.evaluate();
      await new Promise((r) => setTimeout(r, 1000));
      const error = String(m.repl.state.error || '');
      return { error, starts };
    } finally {
      m.stop();
      proto.start = originalStart;
    }
  });
  const source = dist.sourceCommit;
  const metrics = {
    builtAt: dist.builtAt,
    sourceCommit: source ?? null,
    headline: `dist ${dist.builtAt.slice(0, 10)}`,
    starts: result.starts,
  };
  const notes = {
    scope: 'uses the existing website/dist; the probe did not rebuild. Passes only if the dist was built after the newest commit touching packages/ or website/ (uncommitted edits are not covered)',
  };
  if (!source) {
    return { status: 'not-run', metrics, notes: { ...notes, reason: 'could not read the newest source commit from git' } };
  }
  if (!(Date.parse(dist.builtAt) > Date.parse(source.committedAt))) {
    return {
      status: 'fail',
      metrics: { ...metrics, headline: 'stale dist' },
      notes: { ...notes, error: `website/dist is older than source commit ${source.sha}; run pnpm build` },
    };
  }
  if (result.error) return { status: 'fail', metrics, notes: { ...notes, error: result.error } };
  if (page.errors.length) return { status: 'fail', metrics, notes: { ...notes, error: page.errors.slice(0, 5).join('\n') } };
  if (!(result.starts > 0)) {
    return { status: 'fail', metrics, notes: { ...notes, error: 'REPL evaluated but scheduled no audio' } };
  }
  return { status: 'pass', metrics, notes };
}
