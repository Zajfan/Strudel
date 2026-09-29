// LANG-1 (browser): a syntax error and an unknown function, evaluated in the REPL editor, report
// the exact line and column.
import { locateError } from '../../lib/checks.mjs';
import { ERROR_CASES } from '../../lib/patterns.mjs';

export async function probe({ page }) {
  const errors = await page.evaluate(async (codes) => {
    const m = window.strudelMirror;
    const out = [];
    for (const code of codes) {
      m.setCode(code);
      await m.evaluate();
      const e = m.repl.state.error;
      out.push(e ? { message: String(e.message ?? e), loc: e.loc ?? null, stack: e.stack ? String(e.stack) : null } : null);
      m.stop();
    }
    return out;
  }, ERROR_CASES.map((c) => c.code));
  const cases = ERROR_CASES.map((c, k) => {
    const err = errors[k];
    const where = err ? locateError(err, c.code.split('\n').length) : null;
    const exact = !!where && where.line === c.line && where.column === c.column;
    return { name: c.name, message: err ? err.message : null, expected: { line: c.line, column: c.column }, reported: where, exact };
  });
  const exactCount = cases.filter((c) => c.exact).length;
  const metrics = { cases, exact: exactCount, headline: `${exactCount}/${cases.length} exact` };
  const notes = { surface: 'strudelMirror.evaluate(); repl.state.error' };
  if (cases.some((c) => c.message === null)) return { status: 'fail', metrics, notes: { ...notes, error: 'a broken program raised no error' } };
  if (exactCount < cases.length) {
    return { status: 'fail', metrics, notes: { ...notes, error: cases.filter((c) => !c.exact).map((c) => `${c.name}: reported ${JSON.stringify(c.reported)}`).join('; ') } };
  }
  return { status: 'pass', metrics, notes };
}
