// PLUG-1 (desktop): the desktop app plays a pattern on a CLAP instrument, live: Strudel code with
// .clap('Surge XT') in the REPL; the app's native engine (src-tauri/src/audio/plugins.rs) loads the
// plugin and plays the notes at their times. The engine plays on the harness's silent ALSA device,
// and the probe checks what it rendered (engine_capture) and its note counts (engine_stats).
// Without Surge XT in a CLAP folder this is not-run (see the follow-ups doc for installing it).

export const usesPage = true;

const PLUGIN = 'Surge XT';
const CODE = `setcps(1)\nnote("c4 e4 g4 c5").clap('${PLUGIN}')`;
const SECONDS = 3;

export async function probe({ page, thresholds }) {
  const notes = { code: CODE, engine: 'native CLAP host in the desktop app, on the silent device strudel_null' };
  if (thresholds.minRms == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold minRms missing' } };
  const out = await page.evaluate(
    async ({ code, seconds, plugin }) => {
      const native = window.__TAURI_INTERNALS__;
      if (!native) return { missing: 'the native engine (not the desktop app)' };
      const plugins = await native.invoke('clap_plugins');
      if (!plugins.includes(plugin)) return { notInstalled: plugins };
      // the setting's API: moves the engine to the device (and reloads plugins there)
      await setPluginDevice('strudel_null');
      await native.invoke('engine_capture', { start: true });
      const m = window.strudelMirror;
      try {
        m.setCode(code);
        await m.evaluate();
        const error = String(m.repl.state.error || '');
        if (error) return { error };
        await new Promise((r) => setTimeout(r, seconds * 1000));
      } finally {
        m.stop();
      }
      await new Promise((r) => setTimeout(r, 500));
      const bytes = new Uint8Array(await native.invoke('engine_capture', { start: false }));
      const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      let sumSq = 0;
      let peak = 0;
      for (const s of samples) {
        sumSq += s * s;
        peak = Math.max(peak, Math.abs(s));
      }
      const stats = await native.invoke('engine_stats');
      // unloading: the plugin is deactivated and leaves the engine
      await unloadClap(plugin);
      const loadedAfterUnload = await loadedClaps();
      return { stats, loadedAfterUnload, rms: samples.length ? Math.sqrt(sumSq / samples.length) : 0, peak, samples: samples.length };
    },
    { code: CODE, seconds: SECONDS, plugin: PLUGIN },
    { timeoutMs: (SECONDS + 60) * 1000 },
  );
  if (out.missing) return { status: 'fail', metrics: {}, notes: { ...notes, error: `no ${out.missing}` } };
  if (out.notInstalled) {
    return { status: 'not-run', metrics: { plugins: out.notInstalled }, notes: { ...notes, reason: `${PLUGIN} not installed in a CLAP folder (see the follow-ups doc)` } };
  }
  if (out.error) return { status: 'fail', metrics: {}, notes: { ...notes, error: out.error } };
  const { stats } = out;
  // 4 notes per cycle at 1 cps, for SECONDS
  const expectedNotes = 4 * SECONDS;
  const metrics = {
    plugins: stats.plugins,
    device: stats.device,
    loadedAfterUnload: out.loadedAfterUnload,
    notes: stats.notes,
    lateNotes: stats.lateNotes,
    expectedNotes,
    rms: out.rms,
    peak: out.peak,
    capturedSamples: out.samples,
    headline: `${PLUGIN} live: ${stats.notes} notes, ${stats.lateNotes} late, rms ${out.rms.toFixed(3)}`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (!stats.plugins.includes(PLUGIN)) return fail(`${PLUGIN} was not loaded`);
  if (!(stats.notes >= expectedNotes - 1)) return fail(`${stats.notes} notes played, expected about ${expectedNotes}`);
  if (stats.lateNotes > 0) return fail(`${stats.lateNotes} notes arrived late`);
  if (!(out.rms >= thresholds.minRms)) return fail(`rms ${out.rms} below ${thresholds.minRms}`);
  if (stats.device !== 'strudel_null') return fail(`the engine played on ${stats.device}, not the chosen device`);
  if (out.loadedAfterUnload.length) return fail(`still loaded after unloadClap: ${out.loadedAfterUnload}`);
  return { status: 'pass', metrics, notes };
}
