/*
superdoughoutput.mjs - Output controller for superdough

Handles setting up and mixing to the outputs as well as all global (orbit) effects

Copyright (C) 2025 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/superdough/superdoughoutput.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { effectSend, getWorklet } from './helpers.mjs';
import { errorLogger } from './logger.mjs';
import { clamp } from './util.mjs';

const hasChanged = (now, before) => now !== undefined && now !== before;
// Node with fixed stereo channel count to prevent clicking when the input signal
// switches from mono to stereo
const getStereoNode = (ac) => new GainNode(ac, { gain: 1, channelCount: 2, channelCountMode: 'explicit' });

export class Orbit {
  reverbNode;
  delayNode;
  output;
  summingNode;
  djfNode;
  audioContext;

  constructor(audioContext) {
    this.audioContext = audioContext;
    this.output = getStereoNode(audioContext);
    this.summingNode = getStereoNode(audioContext);
    this.summingNode.connect(this.output);
  }

  disconnect() {
    this.output.disconnect();
    this.summingNode.disconnect();
    this.delayNode?.disconnect();
    this.reverbNode?.disconnect();
  }

  getDjf(value, t = 0) {
    if (this.djfNode == null) {
      this.djfNode = getWorklet(this.audioContext, 'djf-processor', { value });
      this.summingNode.disconnect();
      this.summingNode.connect(this.djfNode);
      this.djfNode.connect(this.output);
    }
    const val = this.djfNode.parameters.get('value');
    val.setValueAtTime(value, t);
    return this.djfNode;
  }

  getDelay(delaytime = 0, feedback = 0.5, t) {
    const maxfeedback = 0.98;
    if (feedback > maxfeedback) {
      //logger(`feedback was clamped to ${maxfeedback} to save your ears`);
    }
    feedback = clamp(feedback, 0, 0.98);
    if (this.delayNode == null) {
      this.delayNode = this.audioContext.createFeedbackDelay(1, delaytime, feedback);
      this.delayNode.connect(this.summingNode);
      this.delayNode.start?.(t); // for some reason, this throws when audion extension is installed..
    }
    this.delayNode.delayTime.value !== delaytime && this.delayNode.delayTime.setValueAtTime(delaytime, t);
    this.delayNode.feedback.value !== feedback && this.delayNode.feedback.setValueAtTime(feedback, t);
    return this.delayNode;
  }

  getReverb(duration, fade, lp, dim, ir, irspeed, irbegin) {
    // If no reverb has been created for a given orbit, create one
    if (this.reverbNode == null) {
      this.reverbNode = this.audioContext.createReverb(duration, fade, lp, dim, ir, irspeed, irbegin);
      this.reverbNode.connect(this.summingNode);
    }

    if (
      hasChanged(duration, this.reverbNode.duration) ||
      hasChanged(fade, this.reverbNode.fade) ||
      hasChanged(lp, this.reverbNode.lp) ||
      hasChanged(dim, this.reverbNode.dim) ||
      hasChanged(irspeed, this.reverbNode.irspeed) ||
      hasChanged(irbegin, this.reverbNode.irbegin) ||
      this.reverbNode.ir !== ir
    ) {
      // only regenerate when something has changed
      // avoids endless regeneration on things like
      // stack(s("a"), s("b").rsize(8)).room(.5)
      // this only works when args may stay undefined until here
      // setting default values breaks this
      this.reverbNode.generate(duration, fade, lp, dim, ir, irspeed, irbegin);
    }
    return this.reverbNode;
  }
  sendReverb(node, amount) {
    return effectSend(node, this.reverbNode, amount);
  }

  sendDelay(node, amount) {
    return effectSend(node, this.delayNode, amount);
  }

  // The orbit's duck envelope, as last scheduled (see duck). Kept here because an AudioParam can't
  // report the value it will have at a future time.
  duckEnvelope = null;

  // gain of the orbit output at time t, according to duckEnvelope
  duckGainAt(t) {
    const env = this.duckEnvelope;
    if (!env || t >= env.end) {
      return 1;
    }
    if (t <= env.start) {
      return env.from;
    }
    if (t < env.bottom) {
      return env.from * Math.pow(env.level / env.from, (t - env.start) / (env.bottom - env.start));
    }
    return env.level * Math.pow(1 / env.level, (t - env.bottom) / (env.end - env.bottom));
  }

  duck(t, onsettime = 0, attacktime = 0.1, depth = 1) {
    const onset = onsettime;
    const attack = Math.max(attacktime, 0.002);
    const gainParam = this.output.gain;
    // Scheduled on the audio clock right away, so the duck lands exactly at t, also in offline
    // renders (a main-thread timeout would fire wherever the render happens to be).
    const t0 = Math.max(t, this.audioContext.currentTime);
    const from = this.duckGainAt(t0);
    const level = clamp(1 - Math.sqrt(depth), 0.01, 1);
    gainParam.cancelScheduledValues(t0);
    // a ramp, not a jump: if an earlier duck is still under way, cancelling dropped its next event,
    // and ramping from its last remaining event to `from` continues the same exponential curve
    gainParam.exponentialRampToValueAtTime(from, t0);
    if (onset > 0) {
      gainParam.exponentialRampToValueAtTime(level, t0 + onset);
    } else {
      gainParam.setValueAtTime(level, t0);
    }
    gainParam.exponentialRampToValueAtTime(1, t0 + onset + attack);
    this.duckEnvelope = { start: t0, from, level, bottom: t0 + onset, end: t0 + onset + attack };
  }

  connectToOutput(node) {
    node.connect(this.summingNode);
  }
}

export class SuperdoughOutput {
  channelMerger;
  destinationGain;

  constructor(audioContext) {
    this.audioContext = audioContext;
    this.initializeAudio();
  }

  initializeAudio() {
    const audioContext = this.audioContext;
    const maxChannelCount = audioContext.destination.maxChannelCount;
    // some engines report 0 when they can't tell (WebKitGTK with some audio sinks), and a channel
    // count of 0 throws: then keep the destination's own count
    if (maxChannelCount > 0) {
      this.audioContext.destination.channelCount = maxChannelCount;
    }
    this.channelMerger = new ChannelMergerNode(audioContext, { numberOfInputs: audioContext.destination.channelCount });
    this.destinationGain = new GainNode(audioContext);
    this.channelMerger.connect(this.destinationGain);
    this.destinationGain.connect(audioContext.destination);
  }

  reset() {
    this.disconnect();
    this.initializeAudio();
  }
  disconnect() {
    this.channelMerger.disconnect();
    this.destinationGain.disconnect();
    this.destinationGain = null;
    this.channelMerger = null;
  }
  connectToDestination = (input, channels = [0, 1]) => {
    //This upmix can be removed if correct channel counts are set throughout the app,
    // and then strudel could theoretically support surround sound audio files
    const stereoMix = new StereoPannerNode(this.audioContext);
    input.connect(stereoMix);

    const splitter = new ChannelSplitterNode(this.audioContext, {
      numberOfOutputs: stereoMix.channelCount,
    });
    stereoMix.connect(splitter);
    channels.forEach((ch, i) => {
      splitter.connect(this.channelMerger, i % stereoMix.channelCount, ch % this.audioContext.destination.channelCount);
    });
  };
}

// The cue (headphone) output: a second output device for patterns with `cue`, inaudible on the
// main output. An AudioContext has one output device, so the cue mix leaves the context as a
// MediaStream and plays through an <audio> element, whose own device is set with setSinkId.
export class CueOutput {
  constructor(audioContext) {
    this.destination = audioContext.createMediaStreamDestination();
    this.audio = new Audio();
    this.audio.srcObject = this.destination.stream;
    this.audio.play().catch((err) => errorLogger(new Error(`cue output could not start: ${err.message}`), 'superdough'));
  }
  // deviceId '' is the system default
  async setDevice(deviceId) {
    if (typeof this.audio.setSinkId !== 'function') {
      throw new Error('this browser cannot choose an output device for the cue');
    }
    await this.audio.setSinkId(deviceId);
  }
  disconnect() {
    this.audio.pause();
    this.audio.srcObject = null;
    this.destination.disconnect();
  }
}

export class SuperdoughAudioController {
  audioContext;
  output;
  nodes = {};
  cueNodes = {}; // orbits of cued patterns, connected to the cue output
  buses = {};
  cueOutput; // created when the first cued sound plays
  cueDeviceId = '';

  constructor(audioContext) {
    this.audioContext = audioContext;
    this.output = new SuperdoughOutput(audioContext);
  }

  reset() {
    Object.values(this.nodes).forEach((node) => {
      node.disconnect();
    });
    Object.values(this.buses).forEach((bus) => {
      bus.disconnect();
    });
    Object.values(this.cueNodes).forEach((node) => {
      node.disconnect();
    });
    this.nodes = {};
    this.cueNodes = {};
    this.buses = {};
    this.output.reset();
  }

  getCueOutput() {
    if (this.cueOutput == null) {
      this.cueOutput = new CueOutput(this.audioContext);
      if (this.cueDeviceId) {
        this.cueOutput.setDevice(this.cueDeviceId).catch((err) => errorLogger(err, 'superdough'));
      }
    }
    return this.cueOutput;
  }

  async setCueDevice(deviceId) {
    this.cueDeviceId = deviceId;
    await this.cueOutput?.setDevice(deviceId);
  }

  duck(targetOrbits, t, onsettime = 0, attacktime = 0.1, depth = 1) {
    const targetArr = [targetOrbits].flat();
    const onsetArr = [onsettime].flat();
    const attackArr = [attacktime].flat();
    const depthArr = [depth].flat();

    targetArr.forEach((target, idx) => {
      const orbit = this.nodes[target];

      if (orbit == null) {
        errorLogger(new Error(`duck target orbit ${target} does not exist`), 'superdough');
        return;
      }
      const onset = onsetArr[idx] ?? onsetArr[0];
      // undefined means the default; Math.max(undefined, ...) would be NaN
      const attack = Math.max(attackArr[idx] ?? attackArr[0] ?? 0.1, 0.002);
      const depth = depthArr[idx] ?? depthArr[0];

      orbit.duck(t, onset, attack, depth);
    });
  }

  getOrbit(orbitNum, channels, cue = false) {
    if (cue) {
      if (this.cueNodes[orbitNum] == null) {
        this.cueNodes[orbitNum] = new Orbit(this.audioContext);
        this.cueNodes[orbitNum].output.connect(this.getCueOutput().destination);
      }
      return this.cueNodes[orbitNum];
    }
    if (this.nodes[orbitNum] == null) {
      this.nodes[orbitNum] = new Orbit(this.audioContext);
      this.output.connectToDestination(this.nodes[orbitNum].output, channels);
    }
    return this.nodes[orbitNum];
  }

  getBus(busNum) {
    if (this.buses[busNum] == null) {
      this.buses[busNum] = getStereoNode(this.audioContext);
    }
    return this.buses[busNum];
  }
}
