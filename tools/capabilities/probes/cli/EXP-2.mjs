// EXP-2 (CLI): a stem-export API exists, and per-orbit renders sum to the mix.
import { isStemApiName, judgeStems, stemResidual } from '../../lib/checks.mjs';
import { stemPattern } from '../../lib/patterns.mjs';
import { renderPattern } from '../../lib/render.mjs';
import { loadScope } from '../../lib/scope.mjs';

const ORBITS = [1, 2, 3, 4];

async function stemApis() {
  const names = { '@strudel/core': '@strudel/core', '@strudel/webaudio': '@strudel/webaudio', supradough: '../../../../packages/supradough/dough.mjs' };
  const apis = [];
  const skippedModules = [];
  for (const [name, spec] of Object.entries(names)) {
    try {
      const m = await import(spec);
      for (const k of Object.keys(m)) if (isStemApiName(k)) apis.push(`${name}.${k}`);
    } catch (err) {
      skippedModules.push({ module: name, error: String(err?.message ?? err) });
    }
  }
  return { apis, skippedModules };
}

export async function probe({ thresholds }) {
  await loadScope();
  const opts = { cps: 1, cycles: 2, tail: 0.5 };
  const mix = renderPattern(stemPattern(), opts);
  const stems = ORBITS.map((o) => renderPattern(stemPattern().filterValues((v) => v.orbit === o), opts).left);
  const { residualDbfs } = stemResidual(mix.left, stems);
  const { apis, skippedModules } = await stemApis();
  const metrics = { stemApis: apis, orbits: ORBITS.length, residualDbfs, headline: apis.length ? `${apis.length} stem API(s)` : 'no stem API' };
  const notes = skippedModules.length ? { skippedModules } : {};
  // This probe renders per-orbit stems itself; it does not know how to drive a found API, so any
  // API it finds is unexercised and the cell cannot pass on the API's name alone.
  const verdict = judgeStems({ apis, exercised: false, residualDbfs, eventCount: mix.eventCount }, thresholds);
  if (verdict.status === 'fail' && verdict.error === 'no stem export API') {
    notes.feasibility = `per-orbit renders sum to the mix at ${residualDbfs} dBFS`;
  }
  const { status, error, reason } = verdict;
  return { status, metrics, notes: { ...notes, ...(error && { error }), ...(reason && { reason }) } };
}
