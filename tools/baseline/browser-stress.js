(async () => {
  const m = window.strudelMirror,
    b = window.__baseline;
  const events = [];
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (when, ...args) {
    events.push({ when, now: this.context.currentTime, frequency: this.frequency.value });
    return start.call(this, when, ...args);
  };
  try {
    m.setCode('note("c4").s("sine").fast(64).gain(0.01).release(0.01)');
    await m.evaluate();
    await new Promise((r) => setTimeout(r, 5000));
    const editAt = performance.now(),
      countAtEdit = events.length;
    m.setCode('note("c5").s("sine").fast(64).gain(0.01).release(0.01)');
    await m.evaluate();
    const evaluateMs = performance.now() - editAt;
    await new Promise((r) => setTimeout(r, 5000));
    m.stop();
    const stoppedCount = events.length;
    await new Promise((r) => setTimeout(r, 400));
    const leads = events.map((e) => (e.when - e.now) * 1000).sort((a, b) => a - b);
    const deltas = events.slice(1).map((e, i) => Math.abs(e.when - events[i].when - 1 / 32) * 1000);
    return {
      schedulerUsesWorker: !!m.repl.scheduler.worker,
      eventCount: events.length,
      late: leads.filter((x) => x < 0).length,
      minLeadMs: leads[0],
      medianLeadMs: leads[Math.floor(leads.length / 2)],
      maxGridDeviationMs: Math.max(...deltas),
      evaluateMs,
      eventsAfterEdit: events.length - countAtEdit,
      newPitchObserved: events.slice(countAtEdit).some((e) => Math.abs(e.frequency - 523.251) < 0.01),
      noStartsAfterStop: stoppedCount === events.length,
      errors: b.errors,
      replError: String(m.repl.state.error || ''),
    };
  } finally {
    m.stop();
    OscillatorNode.prototype.start = start;
  }
})();
