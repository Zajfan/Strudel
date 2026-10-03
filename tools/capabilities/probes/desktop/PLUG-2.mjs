// PLUG-2 (desktop): mixing with plugins, beyond one instrument per plugin (PLUG-1).
// 1. Instances: two Surge XTs by id ('bass', 'lead') in one stem render, bass with its volume
//    automated to 0: the bass stem must be silent and the lead stem not (each instance has its own
//    settings); played live, both are loaded under their ids.
// Still to come (the cell fails until they are built and checked): effect plugins on Strudel's
// orbits and on plugins, and VST3 plugins.
// Without Surge XT in a CLAP folder this is not-run (see the follow-ups doc for installing it).

import { renderStemsInPage } from '../../lib/browser/page-render.mjs';

export const usesPage = true;

const PLUGIN = 'Surge XT';
const PENDING = ['effect plugins on orbits and on plugins', 'VST3 plugins'];
const INSTANCES_CODE =
  `setcps(1)\n$: note("c3 ~ ~ ~").clap('${PLUGIN}', { id: 'bass' }).auto(0, { c: 'Global Volume' })\n` +
  `$: note("e4 ~ ~ ~").clap('${PLUGIN}', { id: 'lead' }).orbit(2)`;

// Runs in the page; serialized with toString(), so no closures over Node scope.
async function playFor({ code, seconds }) {
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
  return {};
}

const rmsOf = (samples) => {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / Math.max(1, samples.length));
};

export async function probe({ page, thresholds }) {
  const notes = { plugin: PLUGIN, instances: INSTANCES_CODE };
  if (thresholds.minRms == null) return { status: 'fail', metrics: {}, notes: { ...notes, error: 'threshold minRms missing' } };
  const plugins = await page.evaluate(() => window.__TAURI_INTERNALS__?.invoke('clap_plugins') ?? null);
  if (!plugins?.includes(PLUGIN)) {
    return { status: 'not-run', metrics: { plugins }, notes: { ...notes, reason: `${PLUGIN} not installed in a CLAP folder (see the follow-ups doc)` } };
  }

  // 1. instances
  let instances;
  try {
    const out = await renderStemsInPage(
      page,
      () =>
        stack(
          // (pure: the render's scope parses every string as mini-notation, which would split the name)
          note("c3 ~ ~ ~").clap('Surge XT', { id: 'bass' }).auto(0, { c: pure('Global Volume') }),
          note("e4 ~ ~ ~").clap('Surge XT', { id: 'lead' }).orbit(2),
        ),
      { cps: 1, cycles: 2, sampleRate: 48000 },
    );
    const live = await page.evaluate(playFor, { code: INSTANCES_CODE, seconds: 1.5 });
    if (live.error) throw new Error(live.error);
    const loaded = await page.evaluate(() => loadedClaps());
    const bassParams = await page.evaluate(async () => (await clapParams('bass')).length);
    await page.evaluate(async () => {
      await unloadClap('bass');
      await unloadClap('lead');
    });
    instances = {
      bassStemRms: rmsOf(out.stems.get(1) ?? []),
      leadStemRms: rmsOf(out.stems.get(2) ?? []),
      loaded,
      bassParams,
    };
  } catch (err) {
    instances = { error: String(err?.message ?? err) };
  }

  const metrics = {
    instances,
    pending: PENDING,
    headline: instances.error
      ? `instances: ${instances.error}`
      : `2 instances (bass muted ${instances.bassStemRms.toExponential(1)}, lead ${instances.leadStemRms.toFixed(3)} rms); to do: ${PENDING.join(', ')}`,
  };
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (instances.error) return fail(`instances: ${instances.error}`);
  if (!(instances.leadStemRms >= thresholds.minRms)) return fail(`the lead instance is silent (${instances.leadStemRms})`);
  if (!(instances.bassStemRms < instances.leadStemRms / 10)) return fail("muting the bass instance's volume reached the lead instance (or didn't apply)");
  if (!(instances.loaded.includes('bass') && instances.loaded.includes('lead'))) return fail(`live: loaded instances ${instances.loaded}`);
  if (!(instances.bassParams > 0)) return fail('clapParams(id) listed no parameters');
  if (PENDING.length) return fail(`not built yet: ${PENDING.join(', ')}`);
  return { status: 'pass', metrics, notes };
}
