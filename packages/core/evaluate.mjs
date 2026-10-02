/*
evaluate.mjs - <short description TODO>
Copyright (C) 2022 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/core/evaluate.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

export const strudelScope = {};
// Make strudelScope available globally so transpiled code can access it
globalThis.strudelScope = strudelScope;

// Track user-defined keys (from block-based eval) so we can clear them without removing strudel functions
export const userDefinedKeys = new Set();
globalThis.userDefinedKeys = userDefinedKeys;

/**
 * Clears all user-defined variables and functions from the scope.
 * This removes variables created during block-based evaluation.
 * @name clearScope
 * @example
 * // After defining variables in blocks:
 * // let myVar = 5
 * // function myFunc() { return 10; }
 * clearScope() // removes myVar and myFunc from scope
 */
export const clearScope = () => {
  for (const key of userDefinedKeys) {
    delete strudelScope[key];
    delete globalThis[key];
  }
  userDefinedKeys.clear();
  // Return silence if available (for use in pattern expressions), otherwise undefined
  return globalThis.silence;
};
// Make clearScope available globally
globalThis.clearScope = clearScope;

export const evalScope = async (...args) => {
  const results = await Promise.allSettled(args);
  const modules = results.filter((result) => result.status === 'fulfilled').map((r) => r.value);
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`evalScope: module with index ${i} could not be loaded:`, result.reason);
    }
  });
  // Object.assign(globalThis, ...modules);
  // below is a fix for above commented out line
  // same error as https://github.com/vitest-dev/vitest/issues/1807 when running this on astro server
  modules.forEach((module) => {
    Object.entries(module).forEach(([name, value]) => {
      globalThis[name] = value;
      strudelScope[name] = value;
    });
  });
  return modules;
};

// Stack frames of evaluated code carry this name, so runtime errors can be traced back to it.
const evalSourceURL = 'strudel-eval.js';

// Line of the Function body's first line in its own stack frames: engines put a header
// (`function anonymous(\n) {`) before the body, of a size that differs between engines.
const evalBodyLine = (() => {
  try {
    Function(`throw new Error()\n//# sourceURL=${evalSourceURL}`)();
  } catch (err) {
    return Number(stackPositions(err)[0]?.line ?? NaN);
  }
})();

// [{ line, column }] of the evaluated code's frames in err.stack, innermost first (as the engine reports them)
function stackPositions(err) {
  const pattern = new RegExp(`${evalSourceURL.replace('.', '\\.')}:(\\d+):(\\d+)`, 'g');
  return [...String(err?.stack ?? '').matchAll(pattern)].map(([, line, column]) => ({
    line: Number(line),
    column: Number(column),
  }));
}

function safeEval(str, options = {}) {
  const { wrapExpression = true, wrapAsync = true } = options;
  let [before, after] = ['', ''];
  if (wrapExpression) {
    [before, after] = ['{', '}'];
  }
  if (wrapAsync) {
    [before, after] = [`(async ()=>${before}`, `${after})()`];
  }
  // the code gets lines of its own, so its positions are body positions shifted by one line
  const body = `"use strict";return (${before}\n${str}\n${after})\n//# sourceURL=${evalSourceURL}`;
  return Function(body)();
}

// Positions in `code` (1-based line, 1-based column) of the evaluated code's frames in err.stack
function evalErrorPositions(err) {
  if (Number.isNaN(evalBodyLine)) {
    return [];
  }
  return stackPositions(err)
    .map(({ line, column }) => ({ line: line - evalBodyLine, column }))
    .filter(({ line }) => line >= 1);
}

// Gives a runtime error the location in the user's code that caused it, like acorn does for syntax errors:
// err.loc = { line (1-based), column (0-based) }, and ' (line:column)' appended to the message.
function locateRuntimeError(err, meta) {
  if (!meta?.originalPosition || !err || typeof err !== 'object' || err.loc) {
    return;
  }
  for (const position of evalErrorPositions(err)) {
    const loc = meta.originalPosition(position.line, position.column - 1);
    if (loc) {
      err.loc = loc;
      err.message = `${err.message} (${loc.line}:${loc.column})`;
      return;
    }
  }
}

export const evaluate = async (code, transpiler, transpilerOptions) => {
  let meta = {};

  if (transpiler) {
    // transform syntactically correct js code to semantically usable code
    const transpiled = transpiler(code, transpilerOptions);
    code = transpiled.output;
    meta = transpiled;
  }
  // if no transpiler is given, we expect a single instruction (!wrapExpression)
  const options = { wrapExpression: !!transpiler };
  let evaluated;
  try {
    evaluated = await safeEval(code, options);
  } catch (err) {
    locateRuntimeError(err, meta);
    throw err;
  }
  return { mode: 'javascript', pattern: evaluated, meta };
};
