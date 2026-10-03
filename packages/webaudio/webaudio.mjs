/*
webaudio.mjs - <short description TODO>
Copyright (C) 2022 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/webaudio/webaudio.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as strudel from '@strudel/core';
import {
  superdough,
  getAudioContext,
  setLogger,
  rawdspTrigger,
  registerWorklet,
  setAudioContext,
  initAudio,
  setSuperdoughAudioController,
  resetGlobalEffects,
  errorLogger,
  multiChannelOrbits,
  setMultiChannelOrbits,
} from 'superdough';
import { zipSync } from 'fflate';
import './supradough.mjs';
import { workletUrl } from 'supradough';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
registerWorklet(workletUrl);

const { Pattern, logger, repl } = strudel;

setLogger(logger);

const hap2value = (hap) => {
  hap.ensureObjectValue();
  return hap.value;
};

// uses more precise, absolute t if available, see https://github.com/tidalcycles/strudel/pull/1004
// TODO: refactor output callbacks to eliminate deadline
export const webaudioOutput = (hap, _deadline, hapDuration, cps, t) => {
  return superdough(hap2value(hap), t, hapDuration, cps, hap.whole?.begin.valueOf());
};

export async function renderPatternAudio(
  pattern,
  cps,
  begin,
  end,
  sampleRate,
  maxPolyphony,
  multiChannelOrbits,
  downloadName = undefined,
) {
  const renderedBuffer = collectInserts(pattern, cps, begin, end)
    ? (await renderPatternStems(pattern, cps, begin, end, sampleRate, maxPolyphony)).mix
    : await renderOffline(pattern, cps, begin, end, sampleRate, maxPolyphony, multiChannelOrbits);
  downloadBlob(new Blob([audioBufferToWav(renderedBuffer)], { type: 'audio/wav' }), `${downloadName || defaultName()}.wav`);
}

// Offline renderers: sources outside superdough that render their own audio for exports, such as the
// desktop app's CLAP plugins. A hap whose context names one (`context.offlineRenderer`) is handed to it
// instead of superdough. A renderer is `{ start(audioContext) }`, returning a session for one render:
//   trigger(hap, t, duration, cps): a hap at t seconds (in the order superdough gets them);
//   render(from, to): the haps up to `to` are triggered, schedule the audio for [from, to) seconds;
//   end(): the render is over (also after a failed render).
const offlineRenderers = new Map();
export function registerOfflineRenderer(name, renderer) {
  offlineRenderers.set(name, renderer);
}

// Renders [begin, end) cycles of the pattern offline and returns the AudioBuffer. `channels` is the
// number of output channels; with multiChannelOrbits, orbit n plays on channels 2n-1 and 2n (1-based).
async function renderOffline(pattern, cps, begin, end, sampleRate, maxPolyphony, multiChannelOrbits, channels = 2) {
  let audioContext = getAudioContext();
  await audioContext.close();
  audioContext = new OfflineAudioContext(channels, ((end - begin) / cps) * sampleRate, sampleRate);
  setAudioContext(audioContext);
  setSuperdoughAudioController(new SuperdoughAudioController(audioContext));
  const sessions = new Map();
  try {
    await initAudio({
      maxPolyphony,
      multiChannelOrbits,
    });
    for (const [name, renderer] of offlineRenderers) {
      sessions.set(name, await renderer.start(audioContext));
    }
    const render = { pattern, cps, begin, sessions };

    // Firefox currently doesn't support suspending an OfflineAudioContext,
    // so no chunked rendering. Bad performance, but at least it works.
    return await (audioContext.suspend === undefined
      ? renderPatternAudioWhole(audioContext, render, end)
      : renderPatternAudioInChunks(audioContext, render, end, 1));
  } finally {
    for (const session of sessions.values()) {
      try {
        await session.end();
      } catch (err) {
        errorLogger(err, 'webaudio');
      }
    }
    setAudioContext(null);
    setSuperdoughAudioController(null);
    resetGlobalEffects();
  }
}

// Inserts in renders: effects outside superdough on orbits or the master (superdough's insert
// provider; the desktop app's effect plugins) can't run inside an offline render, so a render with
// any is rendered as stems, which the insert renderer then processes:
//   { masterChain(): chain, process({ stems, chains, master, haps, sampleRate }) -> { stems, mix } }
// with chains: orbit -> its chain (from the first hap that sets it), haps: [{ value, t, duration }].
let insertRenderer;
export function registerInsertRenderer(renderer) {
  insertRenderer = renderer;
}

// the render's inserts, or null if it has none
function collectInserts(pattern, cps, begin, end) {
  if (!insertRenderer) return null;
  const chains = new Map();
  const haps = [];
  for (const hap of pattern.queryArc(begin, end, { _cps: cps })) {
    if (!hap.hasOnset()) continue;
    const value = hap2value(hap);
    if (value.cue) continue;
    haps.push({ value, t: (hap.whole.begin.valueOf() - begin) / cps, duration: hap.duration / cps });
    const orbit = Math.max(1, Number(value.orbit ?? 1));
    if (value.inserts !== undefined && !chains.has(orbit)) chains.set(orbit, value.inserts);
  }
  const master = insertRenderer.masterChain() ?? [];
  const any = master.length > 0 || [...chains.values()].some((chain) => chain?.length);
  return any ? { chains, master, haps } : null;
}

// an OfflineAudioContext has at most 32 channels: 16 stereo orbits
const MAX_STEM_ORBITS = 16;

/**
 * Renders [begin, end) cycles of the pattern once, with every orbit on its own pair of channels, and
 * splits the result into one stereo buffer per orbit (a stem) plus their sum (the mix). Orbit effects
 * (delay, reverb, ducking) stay in their orbit's stem. Orbits are numbered 1 to 16; orbit 0 shares
 * orbit 1's channels, and haps with an explicit `channels` control end up in the stem of those channels.
 * @returns {Promise<{ mix: AudioBuffer, stems: Map<number, AudioBuffer> }>} stems keyed by orbit number
 */
export async function renderPatternStems(pattern, cps, begin, end, sampleRate, maxPolyphony) {
  const orbits = new Set(
    pattern
      .queryArc(begin, end, { _cps: cps })
      .filter((hap) => hap.hasOnset())
      .map((hap) => Math.max(1, Number(hap2value(hap).orbit ?? 1))),
  );
  if (!orbits.size) {
    orbits.add(1);
  }
  const highest = Math.max(...orbits);
  if (highest > MAX_STEM_ORBITS) {
    throw new Error(`stems: orbit ${highest} is above ${MAX_STEM_ORBITS}, the most one render can hold`);
  }
  const previousMultiChannelOrbits = multiChannelOrbits;
  let rendered;
  try {
    rendered = await renderOffline(pattern, cps, begin, end, sampleRate, maxPolyphony, true, highest * 2);
  } finally {
    setMultiChannelOrbits(previousMultiChannelOrbits);
  }
  const { length } = rendered;
  const stereo = () => new AudioBuffer({ numberOfChannels: 2, length, sampleRate: rendered.sampleRate });
  const mix = stereo();
  const stems = new Map();
  for (const orbit of [...orbits].sort((a, b) => a - b)) {
    const stem = stereo();
    for (const side of [0, 1]) {
      const channel = rendered.getChannelData((orbit - 1) * 2 + side);
      stem.copyToChannel(channel, side);
      const sum = mix.getChannelData(side);
      for (let i = 0; i < length; i++) {
        sum[i] += channel[i];
      }
    }
    stems.set(orbit, stem);
  }
  const inserts = collectInserts(pattern, cps, begin, end);
  if (inserts) {
    return insertRenderer.process({ stems, ...inserts, sampleRate: rendered.sampleRate });
  }
  return { mix, stems };
}

/**
 * Renders the pattern's stems (see renderPatternStems) and downloads them as one zip:
 * `<name>-mix.wav` and `<name>-orbit<n>.wav` for every orbit used.
 */
export async function exportPatternStems(pattern, cps, begin, end, sampleRate, maxPolyphony, downloadName = undefined) {
  const { mix, stems } = await renderPatternStems(pattern, cps, begin, end, sampleRate, maxPolyphony);
  const name = downloadName || defaultName();
  const files = { [`${name}-mix.wav`]: new Uint8Array(audioBufferToWav(mix)) };
  for (const [orbit, stem] of stems) {
    files[`${name}-orbit${orbit}.wav`] = new Uint8Array(audioBufferToWav(stem));
  }
  // WAV barely compresses, so the files are stored as they are
  downloadBlob(new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), `${name}-stems.zip`);
}

const defaultName = () => new Date().toISOString();

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function renderPatternAudioWhole(audioContext, render, end) {
  logger(`[webaudio] preloading`);

  await scheduleHapsChunk(render, render.begin, end);

  logger('[webaudio] start rendering');

  return audioContext.startRendering();
}

async function renderPatternAudioInChunks(audioContext, render, end, chunkSizeInCycles) {
  const { begin, cps } = render;
  let currentCycle = begin;
  let renderPromise = null;

  logger('[webaudio] start rendering');

  while (currentCycle <= end) {
    const chunkStart = currentCycle;
    const chunkEnd = Math.min(currentCycle + chunkSizeInCycles, end);

    logger(`[webaudio] preloading cycles ${chunkStart} - ${chunkEnd}`);

    await scheduleHapsChunk(render, chunkStart, chunkEnd);

    logger(`[webaudio] rendering cycles ${chunkStart} - ${chunkEnd}`);

    currentCycle += chunkSizeInCycles;

    // According to the MDN docs, suspends should be scheduled while
    // the audioContext is not currently running for better precision.
    // So we schedule the suspend first, and await after resuming.
    var suspendPromise;
    if (currentCycle < end) {
      // Make sure to suspend one cycle before the next currentCycle
      // so the next haps can be scheduled on time.
      suspendPromise = audioContext.suspend((currentCycle - begin - 1) / cps);
    }

    if (renderPromise === null) {
      renderPromise = audioContext.startRendering();
    } else {
      await audioContext.resume();
    }

    if (currentCycle < end) {
      await suspendPromise;
    }
  }

  logger('[webaudio] finish rendering');

  return renderPromise;
}

async function scheduleHapsChunk({ pattern, cps, begin, sessions }, chunkStart, chunkEnd) {
  // Calling superdough(...) in ascending onset time order is important
  // for controls that depend on the audio graph state like `cut`
  let haps = pattern
    .queryArc(chunkStart, chunkEnd, { _cps: cps })
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  for (const hap of haps) {
    if (hap.hasOnset()) {
      const t = (hap.whole.begin.valueOf() - begin) / cps;
      try {
        const session = sessions.get(hap.context.offlineRenderer);
        if (session) {
          await session.trigger(hap, t, hap.duration / cps, cps);
        } else {
          await superdough(hap2value(hap), t, hap.duration / cps, cps, t);
        }
      } catch (err) {
        errorLogger(err, 'webaudio');
      }
    }
  }
  // the other renderers' audio for this chunk, now that they have its haps
  for (const session of sessions.values()) {
    try {
      await session.render((chunkStart - begin) / cps, (chunkEnd - begin) / cps);
    } catch (err) {
      errorLogger(err, 'webaudio');
    }
  }
}

export function webaudioRepl(options = {}) {
  const audioContext = options.audioContext ?? getAudioContext();
  setAudioContext(audioContext);
  options = {
    getTime: () => audioContext.currentTime,
    defaultOutput: webaudioOutput,
    ...options,
  };
  return repl(options);
}

Pattern.prototype.rawdsp = function () {
  return this.onTrigger(rawdspTrigger, 1);
};

function audioBufferToWav(buffer, opt) {
  opt = opt || {};

  var numChannels = buffer.numberOfChannels;
  var sampleRate = buffer.sampleRate;
  var format = opt.float32 ? 3 : 1;
  var bitDepth = format === 3 ? 32 : 16;

  var result;
  if (numChannels === 2) {
    result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
  } else {
    result = buffer.getChannelData(0);
  }

  return encodeWAV(result, format, sampleRate, numChannels, bitDepth);
}

function encodeWAV(samples, format, sampleRate, numChannels, bitDepth) {
  var bytesPerSample = bitDepth / 8;
  var blockAlign = numChannels * bytesPerSample;

  var buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  var view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* RIFF chunk length */
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, format, true);
  /* channel count */
  view.setUint16(22, numChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * blockAlign, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, blockAlign, true);
  /* bits per sample */
  view.setUint16(34, bitDepth, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, samples.length * bytesPerSample, true);
  if (format === 1) {
    // Raw PCM
    floatTo16BitPCM(view, 44, samples);
  } else {
    writeFloat32(view, 44, samples);
  }

  return buffer;
}

function interleave(inputL, inputR) {
  var length = inputL.length + inputR.length;
  var result = new Float32Array(length);

  var index = 0;
  var inputIndex = 0;

  while (index < length) {
    result[index++] = inputL[inputIndex];
    result[index++] = inputR[inputIndex];
    inputIndex++;
  }
  return result;
}

function writeFloat32(output, offset, input) {
  for (var i = 0; i < input.length; i++, offset += 4) {
    output.setFloat32(offset, input[i], true);
  }
}

function floatTo16BitPCM(output, offset, input) {
  for (var i = 0; i < input.length; i++, offset += 2) {
    var s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeString(view, offset, string) {
  for (var i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
