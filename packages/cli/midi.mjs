/*
midi.mjs - MIDI output for patterns in Node (the CLI), through jzz
Copyright (C) 2025 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/cli/midi.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Pattern, logger } from '@strudel/core';

export { midiMessages, sendAt } from './midi-messages.mjs';
import { midiMessages, sendAt } from './midi-messages.mjs';

// MIDI outputs through jzz, opened by name on first use. Only outputs are opened: opening every
// input (as WebMidi.js does) crashes jazz-midi on ALSA systems with MIDI 2.0 (UMP) ports.
let engine;
const outputs = new Map();

async function getEngine() {
  if (!engine) {
    const { default: JZZ } = await import('jzz');
    engine = JZZ();
  }
  return engine;
}

export async function midiOutputNames() {
  const jzz = await getEngine();
  return jzz.info().outputs.map((o) => o.name);
}

// The output whose name equals `name`, or else contains it; the first output if no name is given.
export async function getMidiOutput(name) {
  const key = name ?? '';
  if (!outputs.has(key)) {
    outputs.set(
      key,
      (async () => {
        const names = await midiOutputNames();
        const match = name == null ? names[0] : (names.find((n) => n === name) ?? names.find((n) => n.includes(name)));
        if (match === undefined) {
          throw new Error(`no MIDI output ${name == null ? 'available' : `named "${name}"`}. Available: ${names.join(', ') || 'none'}`);
        }
        const jzz = await getEngine();
        const port = await jzz.openMidiOut(match);
        logger(`[midi] output: ${match}`);
        return port;
      })(),
    );
  }
  return outputs.get(key);
}

export async function closeMidiOutputs() {
  for (const port of outputs.values()) {
    (await port.catch(() => undefined))?.close();
  }
  outputs.clear();
  await engine?.close?.();
  engine = undefined;
}

/**
 * Sends the pattern to a MIDI output, in Node. Like the browser's .midi(): the output is chosen by
 * name (exact, or a part of it), or with the midiport control; without either, the first output.
 * @name midi
 * @param {string} [output] MIDI output name
 */
Pattern.prototype.midi = function (output) {
  return this.onTrigger(async (hap, _currentTime, cps, targetTime) => {
    hap.ensureObjectValue();
    const time = targetTime * 1000; // the CLI scheduler runs on performance.now() / 1000
    const duration = (hap.duration.valueOf() / cps) * 1000;
    const messages = midiMessages(hap.value, { time, duration });
    if (!messages.length) {
      return;
    }
    const port = await getMidiOutput(hap.value.midiport ?? output);
    for (const { time, bytes } of messages) {
      sendAt(time, () => port.send(bytes));
    }
  });
};
