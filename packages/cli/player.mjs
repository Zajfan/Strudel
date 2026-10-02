/*
player.mjs - plays Strudel code in real time in Node, with MIDI (and no audio) output
Copyright (C) 2025 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/cli/player.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { evalScope, repl } from '@strudel/core';
import { transpiler } from '@strudel/transpiler';

/**
 * A REPL for Node: evaluates code as the browser REPL does (transpiled, with $: blocks), and plays it
 * on a scheduler driven by performance.now(). There is no audio in Node, so patterns sound only
 * through outputs like .midi(). Returns { evaluate(code), stop(), state }.
 */
export async function createNodePlayer({ log = console.log } = {}) {
  await evalScope(import('@strudel/core'), import('@strudel/mini'), import('@strudel/tonal'), import('./midi.mjs'));
  let warned = false;
  const player = repl({
    // haps without an output: say once that the CLI has no audio
    defaultOutput: async () => {
      if (!warned) {
        warned = true;
        log('[strudel] no audio in the CLI: send patterns to an output, e.g. .midi()');
      }
    },
    getTime: () => performance.now() / 1000,
    transpiler,
    onEvalError: (err) => log(`[strudel] error: ${err.message}`),
  });
  return {
    evaluate: (code) => player.evaluate(code),
    stop: () => player.stop(),
    state: player.state,
  };
}
