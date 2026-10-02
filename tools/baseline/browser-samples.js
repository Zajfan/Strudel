(async () => {
  const m = window.strudelMirror,
    b = window.__baseline;
  const begin = b.starts.length;
  m.setCode('s("bd*4").bank("tr909").gain(0.03)');
  await m.evaluate();
  const levels = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    for (const a of b.analysers) {
      const data = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(data);
      levels.push(Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length));
    }
  }
  m.stop();
  return {
    sampleStarts: b.starts.slice(begin).filter((x) => x.type === 'AudioBufferSourceNode').length,
    maxRms: Math.max(...levels),
    nonzeroWindows: levels.filter((x) => x > 0.00001).length,
    errors: b.errors,
    replError: String(m.repl.state.error || ''),
  };
})();
