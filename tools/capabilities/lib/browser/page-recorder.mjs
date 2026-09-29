// Records LIVE REPL playback sample-accurately in the page. An AudioWorklet recorder (loaded from a
// Blob URL) taps superdough's final output node, getSuperdoughAudioController().output.destinationGain
// (the GainNode that feeds context.destination; packages/superdough/superdoughoutput.mjs), so it
// hears the true master mix. Oscillator starts are logged with their context time and frequency so
// callers can locate events in the recording.
import { decodeFloat32 } from '../measure.mjs';

// Runs in the page; serialized with toString(), so it must not close over module scope.
async function recordLiveScript({ code, seconds }) {
  const RECORDER = `
    class CapsRecorder extends AudioWorkletProcessor {
      constructor() {
        super();
        this.chunks = [];
        this.startFrame = null;
        this.recording = true;
        this.port.onmessage = (e) => {
          if (e.data !== 'dump') return;
          this.recording = false;
          const length = this.chunks.reduce((n, c) => n + c.length, 0);
          const out = new Float32Array(length);
          let at = 0;
          for (const c of this.chunks) { out.set(c, at); at += c.length; }
          this.port.postMessage({ startFrame: this.startFrame, samples: out }, [out.buffer]);
        };
      }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (this.recording && ch) {
          if (this.startFrame === null) this.startFrame = currentFrame;
          this.chunks.push(ch.slice());
        }
        return true;
      }
    }
    registerProcessor('caps-recorder', CapsRecorder);
  `;
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const url = URL.createObjectURL(new Blob([RECORDER], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const tapSource = getSuperdoughAudioController().output.destinationGain;
  const recorder = new AudioWorkletNode(ctx, 'caps-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2 });
  // Keep the recorder pulled by the graph without adding anything audible.
  const sink = new GainNode(ctx, { gain: 0 });
  tapSource.connect(recorder);
  recorder.connect(sink).connect(ctx.destination);

  const protoStart = AudioScheduledSourceNode.prototype.start;
  const starts = [];
  AudioScheduledSourceNode.prototype.start = function (when = 0, ...rest) {
    if (this instanceof OscillatorNode) starts.push({ when, now: this.context.currentTime, freq: this.frequency.value });
    return protoStart.call(this, when, ...rest);
  };
  const m = window.strudelMirror;
  let error = '';
  let dump;
  try {
    m.setCode(code);
    await m.evaluate();
    error = String(m.repl.state.error || '');
    await new Promise((r) => setTimeout(r, seconds * 1000));
    dump = await new Promise((resolve) => {
      recorder.port.onmessage = (e) => resolve(e.data);
      recorder.port.postMessage('dump');
    });
  } finally {
    m.stop();
    AudioScheduledSourceNode.prototype.start = protoStart;
    tapSource.disconnect(recorder);
    recorder.disconnect();
    sink.disconnect();
  }
  const bytes = new Uint8Array(dump.samples.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return {
    error,
    b64: btoa(binary),
    startFrame: dump.startFrame,
    sampleRate: ctx.sampleRate,
    starts,
    tap: 'getSuperdoughAudioController().output.destinationGain',
  };
}

// recordLive(page, code, { seconds }) → { left, startFrame, sampleRate, starts, error, tap }.
// `left` is channel 0 of the master mix; sample i is context frame startFrame + i.
export async function recordLive(page, code, { seconds = 3 } = {}) {
  const out = await page.evaluate(recordLiveScript, { code, seconds }, { timeoutMs: (seconds + 30) * 1000 });
  return { ...out, left: decodeFloat32(out.b64), b64: undefined };
}
