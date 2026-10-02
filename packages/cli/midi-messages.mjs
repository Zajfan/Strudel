/*
midi-messages.mjs - MIDI messages for hap values, and precise sending in Node
Copyright (C) 2025 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/cli/midi-messages.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Kept apart from midi.mjs, which replaces Pattern.prototype.midi when imported.
import { noteToMidi } from '@strudel/core';

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CONTROL_CHANGE = 0xb0;
const PROGRAM_CHANGE = 0xc0;
// system real-time messages for midicmd
const COMMANDS = { clock: 0xf8, midiClock: 0xf8, start: 0xfa, continue: 0xfb, stop: 0xfc };
// a note-off goes out this much before the next note-on could, so repeated notes don't overlap
const NOTE_OFF_EARLY_MS = 10;

/**
 * The MIDI messages for one hap value, at `time` (ms) with `duration` (ms), as [{ time, bytes }].
 * Same controls and defaults as the browser's .midi(): note, velocity (0..1, default 0.9) times gain,
 * midichan (1-16), ccn/ccv (ccv 0..1), progNum, and midicmd (clock, start, stop, continue).
 */
export function midiMessages(value, { time, duration }) {
  const { note, ccn, ccv, progNum, midicmd, velocity = 0.9, gain = 1, midichan = 1 } = value;
  const channel = Math.min(15, Math.max(0, Math.round(midichan) - 1));
  const messages = [];
  if (note != null) {
    const number = typeof note === 'number' ? Math.round(note) : noteToMidi(note);
    const vel = Math.min(127, Math.max(0, Math.round(gain * velocity * 127)));
    const off = time + Math.max(0, duration - Math.min(NOTE_OFF_EARLY_MS, duration / 2));
    messages.push({ time, bytes: [NOTE_ON + channel, number, vel] }, { time: off, bytes: [NOTE_OFF + channel, number, 0] });
  }
  if (ccn != null && ccv != null) {
    if (typeof ccv !== 'number' || ccv < 0 || ccv > 1) {
      throw new Error('expected ccv to be a number between 0 and 1');
    }
    messages.push({ time, bytes: [CONTROL_CHANGE + channel, Number(ccn), Math.round(ccv * 127)] });
  }
  if (progNum != null) {
    messages.push({ time, bytes: [PROGRAM_CHANGE + channel, Math.round(progNum)] });
  }
  if (COMMANDS[midicmd] !== undefined) {
    messages.push({ time, bytes: [COMMANDS[midicmd]] });
  }
  return messages;
}

// Timers in Node fire up to a few ms late. To send close to `timeMs` (performance.now() time), wait
// with a timer until SPIN_MS before it, then spin on the clock for the rest.
const SPIN_MS = 2;
export function sendAt(timeMs, send, now = () => performance.now()) {
  const spin = () => {
    while (now() < timeMs) {
      // wait for the exact time
    }
    send();
  };
  const wait = timeMs - now() - SPIN_MS;
  if (wait > 0) {
    setTimeout(spin, wait);
  } else {
    spin();
  }
}
