// BUILD-0 (browser): the production build loads, the REPL starts, and a pattern evaluates without
// error and actually schedules audio (a pattern that "evaluates" but triggers nothing is not a pass).
export async function probe({ page, dist }) {
  const result = await page.evaluate(async () => {
    const proto = AudioScheduledSourceNode.prototype;
    const originalStart = proto.start;
    let starts = 0;
    proto.start = function (...args) {
      starts++;
      return originalStart.apply(this, args);
    };
    try {
      const m = window.strudelMirror;
      m.setCode('note("c4").s("sine").gain(0.01)');
      await m.evaluate();
      await new Promise((r) => setTimeout(r, 1000));
      const error = String(m.repl.state.error || '');
      m.stop();
      return { error, starts };
    } finally {
      proto.start = originalStart;
    }
  });
  const metrics = { builtAt: dist.builtAt, headline: `dist ${dist.builtAt.slice(0, 10)}`, starts: result.starts };
  if (result.error) return { status: 'fail', metrics, notes: { error: result.error } };
  if (page.errors.length) return { status: 'fail', metrics, notes: { error: page.errors.slice(0, 5).join('\n') } };
  if (!(result.starts > 0)) {
    return { status: 'fail', metrics, notes: { error: 'REPL evaluated but scheduled no audio' } };
  }
  return { status: 'pass', metrics, notes: { scope: 'uses the existing website/dist; does not rebuild' } };
}
