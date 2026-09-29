// LANG-1 (CLI): a syntax error and an unknown function report the exact line and column.
import { evaluate } from '@strudel/transpiler';
import { locateError } from '../../lib/checks.mjs';
import { ERROR_CASES } from '../../lib/patterns.mjs';
import { loadScope } from '../../lib/scope.mjs';

export async function probe() {
  await loadScope();
  const cases = [];
  for (const c of ERROR_CASES) {
    let err = null;
    try {
      await evaluate(c.code);
    } catch (e) {
      err = e;
    }
    const lines = c.code.split('\n').length;
    const where = err ? locateError(err, lines) : null;
    const exact = !!where && where.line === c.line && where.column === c.column;
    cases.push({ name: c.name, message: err ? String(err.message) : null, expected: { line: c.line, column: c.column }, reported: where, exact });
  }
  const exactCount = cases.filter((c) => c.exact).length;
  const metrics = { cases, exact: exactCount, headline: `${exactCount}/${cases.length} exact` };
  if (cases.some((c) => c.message === null)) return { status: 'fail', metrics, notes: { error: 'a broken program raised no error' } };
  if (exactCount < cases.length) {
    return { status: 'fail', metrics, notes: { error: cases.filter((c) => !c.exact).map((c) => `${c.name}: reported ${JSON.stringify(c.reported)}`).join('; ') } };
  }
  return { status: 'pass', metrics, notes: {} };
}
