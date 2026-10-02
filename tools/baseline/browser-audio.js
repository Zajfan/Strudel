(async () => {
  const m = window.strudelMirror;
  if (!m) return { ready: false, body: document.body.innerText.slice(0, 1200), errors: window.__baseline?.errors };
  m.setCode('note("c4 e4 g4 b4").s("sine").gain(0.05).release(0.05)');
  await m.evaluate();
  const rms = [];
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    for (const a of __baseline.analysers) {
      const data = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(data);
      rms.push(Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length));
    }
  }
  const starts = __baseline.starts.filter((x) => x.when > 0);
  const lead = starts.map((x) => (x.when - x.now) * 1000);
  const state = { ...m.repl.state };
  const report = {
    ready: true,
    scheduler: m.repl.scheduler.constructor.name,
    contexts: __baseline.contexts.map((x) => ({ state: x.state, sampleRate: x.sampleRate, time: x.currentTime })),
    audioStarts: starts.length,
    lateStarts: lead.filter((x) => x < 0).length,
    minLeadMs: Math.min(...lead),
    maxRms: Math.max(...rms),
    nonzeroWindows: rms.filter((x) => x > 0.00001).length,
    error: String(state.error || ''),
    errors: __baseline.errors,
  };
  m.stop();
  return report;
})();
