#!/usr/bin/env node
// strudel play <file> [--watch]: plays a Strudel file in real time, with MIDI output. With --watch,
// it re-evaluates the file on every save; if the new code fails, the previous pattern keeps playing.
import { readFileSync, watch } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createNodePlayer } from '../player.mjs';
import { closeMidiOutputs, midiOutputNames } from '../midi.mjs';

const usage = `usage: strudel play <file> [--watch]
       strudel midi-outputs`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { watch: { type: 'boolean', short: 'w' }, help: { type: 'boolean', short: 'h' } },
});
const [command, file] = positionals;
const log = (message) => console.log(message);

if (values.help || !command) {
  console.log(usage);
  process.exit(command ? 0 : 1);
}

if (command === 'midi-outputs') {
  for (const name of await midiOutputNames()) console.log(name);
  await closeMidiOutputs();
  process.exit(0);
}

if (command !== 'play' || !file) {
  console.error(usage);
  process.exit(1);
}

const path = resolve(file);
const player = await createNodePlayer({ log });
const play = async () => {
  let code;
  try {
    code = readFileSync(path, 'utf8');
  } catch (err) {
    log(`[strudel] cannot read ${path}: ${err.message}`);
    return;
  }
  await player.evaluate(code);
  if (!player.state.error) log(`[strudel] playing ${file}`);
};
await play();

if (values.watch) {
  let timer;
  // editors save in several steps; evaluate once things settle
  watch(path, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await play();
      log('[strudel] reloaded');
    }, 100);
  });
  log(`[strudel] watching ${file} (ctrl-c to stop)`);
}

const shutdown = async () => {
  player.stop();
  await closeMidiOutputs();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
